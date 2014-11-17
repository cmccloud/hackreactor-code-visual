// TODO: Error handling
var github = require("./githubScraperHelpers");
var secret = require("../config/secret");
var mongoose = require("mongoose");
var Organization = require("../models/Organization");

// Connect to mongo
mongoose.connect(secret.db);
mongoose.connection.on('error', function() {
  console.error('MongoDB Connection Error. Make sure MongoDB is running.');
});

// Save data to mongo
var saveData = function(org, next) {
  org.save(function(err, user, numberAffected) {
    if (err) console.log("Error saving data to mongo", err);
    else {
      console.log("All data saved to mongo! ", numberAffected, " entries affected");
      next(org);
    }
  });
};

/**
 * ======= STEP 0 ========
 *
 * Makes an initial call to GitHub with the organization we want to lookup.
 * Creates a new entry in mongo if that organization does not exist yet.
 */

exports.getOrganization = function(name, next) {
  name = name || 'hackreactor';

  github.authenticateWithToken();

  github.orgs.getAsync({ org: name, per_page: 100})
  .then(function(org) {
    // Check to see if organization already exists in our db and create a new one if not
    Organization.findOne({ login: org.login }, (function(err, existingOrg) {
      if (existingOrg) {
        next(existingOrg); // Pass on reference to the existing org
      } else {
        var newOrg = new Organization();
        newOrg.login = org.login;
        newOrg.profile.name = org.name;
        newOrg.profile.url = org.html_url;
        newOrg.profile.avatar = org.avatar_url;
        newOrg.profile.location = org.location;
        newOrg.profile.email = org.email;
        newOrg.profile.public_repos = org.public_repos;
        newOrg.profile.public_gists = org.public_gists;
        newOrg.profile.followers = org.followers;
        newOrg.profile.following = org.following;
        newOrg.profile.created_at = org.created_at;
        newOrg.profile.updated_at = org.updated_at;
        newOrg.save(function(err) {
          console.log("saving new org", newOrg.name);
          next(newOrg); // Pass on reference to the new org
        });
      }
    }));
  });
};

/**
 * ======= STEP 1 ========
 *
 * Gets both hidden and public memberships in Hack Reactor for currently authenticated user.
 * Stores all members in user.members array in Mongo
 */

exports.getMembers = function(org, next) {
  var pages = 2;
  org.members = [];

  github.authenticateWithToken();
  getGithubMembers();

  // Gets all the members in order to completion, then saves data
  function getGithubMembers(page) {
    page = page || 1;
    // After all members gotten, save the data and send a response
    if (page > pages) {
      saveData(org, next);
    } else {
      console.log("Requesting page ", page, " members");
      github.orgs.getMembersAsync({ org: "hackreactor", per_page: 100, page: page})
      .then(function(members) {
        members.forEach(function(member) {
          console.log("adding ", member.login);
          org.members.push({
            username: member.login,
            repos: []
          });
        });
        // Recursively call with the next page until we reach set page number above
        getGithubMembers(page + 1);
      });
    }
  }
};


/**
 * ======= STEP 2 ========
 *
 * Goes through each member in the authenticated user's members array and gets all repos associated with each member
 * Stores ONLY REPOS UPDATED IN THE LAST WEEK in user.members.[[member]].repos array in mongo. NOTE: Update does not mean a commit was made
 */

// TODO: rethink ++completed requests
exports.getMemberRepos = function(org, next) {
  var members = org.members;
  var completedMembers = 0;
  var repoCount = 0;

  github.authenticateWithToken();
  
  // For each member, send a request to github for their repos
  members.forEach(function(member) {
    member.repos = []; // Reset repos

    var options = {
      user: member.username,
      sort: "updated",
      type: "owner", // Avoid duplicates across groups
      per_page: 100
    };

    github.repos.getFromUserAsync(options)
    .then(function(repos) {
      // Push recently updated repos to mongo
      repos && repos.forEach(function(repo) {
        if (wasUpdatedThisWeek(repo)) {
          console.log("adding ", repo.full_name);
          member.repos.push({
            name: repo.name,
            stats: []
          });
          repoCount++; // increment counter on mongo for org.recentlyUpdatedRepoCount
        }
      });

      // Waits until all repos have been completed until saving to DB
      if (++completedMembers === members.length) {
        org.recentlyUpdatedRepoCount = repoCount;
        saveData(org, next);
      }
    });
  });
  
  function wasUpdatedThisWeek(repo) {
    var updatedAt = new Date(repo.updated_at);
    var now = new Date();
    var lastWeek = new Date(now);
    lastWeek.setDate(lastWeek.getDate() - 7);

    return updatedAt > lastWeek && updatedAt < now;
  }
};


/**
 * ======= STEP 3 ========
 *
 * Goes through each repo in the authenticated org's members array and gets all stats associated with each repo
 * Stores all stats in org.members.[[member]].[[repo]].stats array in mongo
 * 
 * This is an expensive call so Github only returns archived data
 * We have to make the calls twice in order to make sure they are archived. (There's got to be a better way)
 * NOTE: All stats are stored as a stringified form
 */

exports.getRepoStats = function(org, next) {
  console.log("github.getRepoStats called");
  var members = org.members;
  var completedRepos = 0;

  github.authenticateWithToken();
  
  members.forEach(function(member) {
    // Skip over any member that has no recently updated repos
    member.repos.length > 0 && member.repos.forEach(function(repo) {
      var options = {
        username: member.username,
        repo: repo.name,
        token: secret.githubToken
      };

      // Get codeFrequency stats
      github.repos.stats.codeFrequencyAsync(options)
      .then(function(stats) {
        console.log("repo found! got codeFrequency for member ", member.username, " and repo ", repo.name);
        repo.stats.codeFrequency = stats;
      });

      // Get punchCard stats
      github.repos.stats.punchCardAsync(options)
      .then(function(stats) {
        console.log("repo found! got punchCard for member ", member.username, " and repo ", repo.name);
        repo.stats.punchCard = stats;
        console.log("number of completed requests down: ", completedRepos + 1);
        // Save data to mongo when all recently updated repos have been accounted for
        if (++completedRepos === org.recentlyUpdatedRepoCount) {
          saveData(org, next);
        }
      });
    });
  });
};

/**
 * ======= STEP 4 ========
 *
 * Everything is complete! Send a success response
 */

exports.allDone = function(org) {
  console.log("Got all github data! Woo! Closing down mongo...");
  mongoose.connection.close();
};