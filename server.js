var path = require('path');
var url = require('url');
var express = require('express');
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');
var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'http://stun.festumevento.com:8443/',
        ws_uri: 'ws://live.festumevento.in:8888/kurento'
    }
});
var options = {
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};
var app = express();
var idCounter = 0;
var candidatesQueue = {};
var kurentoClient = null;
var presenter = {};
var viewers = [];
var noPresenterMessage = 'No active presenter. Try again later...';
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});
var wss = new ws.Server({
    server : server,
    path : '/one2many'
});
function nextUniqueId() {
	idCounter++;
	return idCounter.toString();
}
var userId = null;
wss.on('connection', function(ws, req) {
	var userId = nextUniqueId();
	var sessionId = nextUniqueId();
	const queryString = req.url.split('?')[1];
	if (queryString) {
		const queryParams = new URLSearchParams(queryString);
		sessionId = queryParams.get('sessionId');
	}
	console.log('Connection received with sessionId ' + sessionId);
    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });
    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });
    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ');
        switch (message.id) {
        case 'presenter':
			startPresenter(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'presenterResponse',
						response : 'rejected',
						message : error
					}));
				}
				ws.send(JSON.stringify({
					id : 'presenterResponse',
					response : 'accepted',
					sdpAnswer : sdpAnswer
				}));
			});
			break;
        case 'viewer':
			startViewer(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'viewerResponse',
						response : 'rejected',
						message : error
					}));
				}
				ws.send(JSON.stringify({
					id : 'viewerResponse',
					response : 'accepted',
					sdpAnswer : sdpAnswer
				}));
			});
			break;
        case 'stop':
            stop(sessionId);
            break;
        case 'onIceCandidate':
            onIceCandidate(message.type, sessionId, message.candidate);
            break;
        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }
    });
});
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }
    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}
function startPresenter(sessionId, ws, sdpOffer, callback) {
	clearCandidatesQueue(sessionId);
	if (presenter[sessionId] && presenter[sessionId] !== null) {
		stop(sessionId);
		return callback("Another user is currently acting as presenter. Try again later ...");
	}
	presenter[sessionId] = {
		id : sessionId,
		pipeline : null,
		webRtcEndpoint : null
	}
	getKurentoClient(function(error, kurentoClient) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}
		if (presenter[sessionId] && presenter[sessionId] === null) {
			stop(sessionId);
			return callback(noPresenterMessage);
		}
		kurentoClient.create('MediaPipeline', function(error, pipeline) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}
			if (presenter[sessionId] && presenter[sessionId] === null) {
				stop(sessionId);
				return callback(noPresenterMessage);
			}
			presenter[sessionId].pipeline = pipeline;
			pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
				if (error) {
					stop(sessionId);
					return callback(error);
				}
				if (presenter[sessionId] && presenter[sessionId] === null) {
					stop(sessionId);
					return callback(noPresenterMessage);
				}
				presenter[sessionId].webRtcEndpoint = webRtcEndpoint;
                if (candidatesQueue[sessionId]) {
                    while(candidatesQueue[sessionId].length) {
                        var candidate = candidatesQueue[sessionId].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }
                webRtcEndpoint.on('OnIceCandidate', function(event) {
                    var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                    ws.send(JSON.stringify({
                        id : 'iceCandidate',
                        candidate : candidate
                    }));
                });
				webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
					if (error) {
						stop(sessionId);
						return callback(error);
					}
					if (presenter[sessionId] && presenter[sessionId] === null) {
						stop(sessionId);
						return callback(noPresenterMessage);
					}
					callback(null, sdpAnswer);
				});
                webRtcEndpoint.gatherCandidates(function(error) {
                    if (error) {
                        stop(sessionId);
                        return callback(error);
                    }
                });
            });
        });
	});
}
function startViewer(sessionId, ws, sdpOffer, callback) {
	clearCandidatesQueue(userId);
	// if (presenter[sessionId] && presenter[sessionId] === null) {
	// 	stop(sessionId);
	// 	return callback(noPresenterMessage);
	// }
	presenter[sessionId].pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
		if (error) {
			// stop(sessionId);
			return callback(error);
		}
		viewers[userId] = {
			"webRtcEndpoint" : webRtcEndpoint,
			"ws" : ws
		}
		if (presenter[sessionId] && presenter[sessionId] === null) {
			//stop(sessionId);
			return callback(noPresenterMessage);
		}
		if (candidatesQueue[userId]) {
			while(candidatesQueue[userId].length) {
				var candidate = candidatesQueue[userId].shift();
				webRtcEndpoint.addIceCandidate(candidate);
			}
		}
        webRtcEndpoint.on('OnIceCandidate', function(event) {
            var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
            ws.send(JSON.stringify({
                id : 'iceCandidate',
                candidate : candidate
            }));
        });
		webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
			if (error) {
				// stop(sessionId);
				return callback(error);
			}
			if (presenter[sessionId] && presenter[sessionId] === null) {
				// stop(sessionId);
				return callback(noPresenterMessage);
			}
			presenter[sessionId].webRtcEndpoint.connect(webRtcEndpoint, function(error) {
				if (error) {
					// stop(sessionId);
					return callback(error);
				}
				if (presenter[sessionId] && presenter[sessionId] === null) {
					// stop(sessionId);
					return callback(noPresenterMessage);
				}
				callback(null, sdpAnswer);
		        webRtcEndpoint.gatherCandidates(function(error) {
		            if (error) {
			            // stop(sessionId);
			            return callback(error);
		            }
		        });
		    });
	    });
	});
}
function clearCandidatesQueue(sessionId) {
	if (candidatesQueue[sessionId]) {
		delete candidatesQueue[sessionId];
	}
}
function stop(sessionId) {
	console.log(presenter[sessionId]);
	if (presenter[sessionId] && presenter[sessionId] !== null && presenter[sessionId].id && presenter[sessionId].id == sessionId) {
		for (var i in viewers) {
			var viewer = viewers[i];
			if (viewer.ws) {
				viewer.ws.send(JSON.stringify({
					id : 'stopCommunication'
				}));
			}
		}
		presenter[sessionId].pipeline.release();
		presenter[sessionId] = null;
		viewers = [];
	} else if (viewers[sessionId]) {
		viewers[sessionId].webRtcEndpoint.release();
		delete viewers[sessionId];
	}
	clearCandidatesQueue(sessionId);
	if (viewers.length < 1 && !presenter[sessionId]) {
        console.log('Closing kurento client');
        try{
			kurentoClient.close();
		}catch(e){}
        kurentoClient = null;
    }
}
function onIceCandidate(type, sessionId, _candidate) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);
    if (type == 'pub' && presenter[sessionId] && presenter[sessionId].id === sessionId && presenter[sessionId].webRtcEndpoint) {
        console.info('Sending presenter candidate');
        presenter[sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else if (viewers[userId] && viewers[userId].webRtcEndpoint) {
        console.info('Sending viewer candidate');
        viewers[userId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}
// app.use(express.static(path.join(__dirname, 'static')), (req, res) => {
// 	console.log('req', req);
// });
app.get('/:sessionId', function (req, res, next) {
	console.log('req params',req.params);
	res.redirect('https://livestream.festumevento.com/?sessionId='+req.params.sessionId)
});
app.use(express.static(path.join(__dirname, 'static')));


