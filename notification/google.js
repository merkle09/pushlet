var gcm = require('dpush'),
    redis = require('redis'),
    responder = require('../responder'),
    log  = require('../log').logger;

var config = require('../config.json');

// set up redis
var port = config.redis.port || 6379,
    host = config.redis.host || 'localhost';

var redisClient = redis.createClient(port, host);
redisClient.on("error", function (err) {
  log.error("Redis Error: " + err);
});


function sendMessage(request, response) {
  var payload = request.body.notification;

  if (request.body.debug) {
    log.debug("Incoming Payload (GCM)", payload);
  }

  try {
    gcm.send(request.body.key, request.body.deviceId, payload, function (err, res) {
      if (err) {
        var error;

        if (err.toString().match("400")) {
          error = 'Invalid Payload';
        } else if (err.toString().match("401")) {
          error = 'Bad Key';
        } else {
          error = 'Unknown Error';
        }

        if (request.body.debug) {
          log.debug("GCM Response", err.toString());
        }

        response.end(responder.err({ error: error }));
      } else {
        // we should only be sending a single id
        if (res.failure) {
          if (res.invalidIds && res.invalidIds.length) {
            response.end(responder.err({ error: "Invalid Device ID", invalidIds: res.invalidIds }));
          } else if (res.updatedIds && res.updatedIds.length) {
            response.end(responder.err({ error: "Updated Device ID", updatedIds: res.updatedIds }));
          } else {
            response.end(responder.err({ error: "Unknown Error" }));
          }
        } else {
          response.end(responder.ok());
        }
      }
    });
  } catch (majorError) {
    response.end(responder.err({ error: majorError.toString() }));
  }
}


// if there is no certificate, see if one can be found
function handleExistingAuth (request, response) {
  var appId = request.body.appId,
      mode  = request.body.mode;

  // check redis for an existing certificate for this appId
  if (redisClient && redisClient.connected) {
    redisClient.get(appId + "_" + mode + "_gcmkey", function (err, reply) {
      if (reply === null) {
        log.debug("No GCM key found in Redis for "+appId+" ("+mode+")");
        response.end(responder.err({ error: "Missing Key" }));
      } else {
        log.debug("Found a GCM key in Redis for "+appId+" ("+mode+")");
        request.body.key = reply;

        sendMessage(request, response);
      }
    });
  } else {
    log.info("No redis connection, can't check for existing certificate");
    response.end(responder.err({ error: "Internal Server Error" }));
  }
}

// certificate passed in, yay!
function handleNewAuth (request, response) {
  var appId = request.body.appId,
      mode  = request.body.mode,
      key   = request.body.key;

  if (redisClient && redisClient.connected) {
    redisClient.set(appId + "_" + mode + "_gcmkey", key, function (err, replies) {
      log.debug("Saved GCM key in Redis");
      sendMessage(request, response);
    });
  } else {
    log.info("No Redis connection, can't store GCM key");
    sendMessage(request, response);
  }
}



// entry for the module, handle the message
function handleMessage (request, response) {
  log.debug("Push to "+request.body.deviceId);

  if (request.body.key !== undefined) {
    // If a key is provided, store it in redis
    log.debug("New key provided in request");
    handleNewAuth(request, response);
  } else {
    log.debug("No key provided, attempt to look up cert in the cache");
    handleExistingAuth(request, response);
  }
}

exports.handleMessage = handleMessage;
