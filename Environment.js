/* Environment -- This superclass should be extended by all environment implementations. */
'use strict';

var jsonfile = require('jsonfile');
var logger = require('./Logger.js');
var CancellableEventEmitter = require('./CancellableEventEmitter.js');

class Environment extends CancellableEventEmitter {

    get name() { return this._name; }
    get envName() { return this._envName; }


    get requiredParams() { return []; }
    get optionalParams() { return []; }
    
    constructor(envName, name) {
        super();
    
        this._envName = envName;
        this._name = name;
        
        this._params = {};
        
    }
    
    
    param(key) { return this._params[key]; }
    get params() { return Object.assign({}, this._params); }
    
    
    initialize() {
        var params = {};
        
        //Load and check parameters
        var fileName = "config/" + this._name.toLowerCase() + "." + this._envName.toLowerCase() + ".env.json";
        try {
            params = jsonfile.readFileSync(fileName);
            logger.info(`Initializing environment ${this._envName} with name ${this._name}.`);
        } catch(e) {
            logger.error(`Error trying to load the config file ${fileName} because of: ${e}`);
        }

        for (let reqParam of this.requiredParams) {
            if (params[reqParam]) this._params[reqParam] = params[reqParam];
            if (this._params[reqParam] === undefined) {
                logger.error(`Failed loading required parameter: ${reqParam}`);
                return false;
            }
        }
        
        for (let optParam of this.optionalParams) {
            if (params[optParam]) this._params[optParam] = params[optParam];
            if (this._params[optParam] === undefined) this._params[optParam] = null;
        }

        return true;
    }
    
    
    log(method, subject) {
        if (!subject) {
            subject = method;
            method = 'info';
        }
        logger.log(method, '{'+ this._name + '} ' + subject);
    }
    
    makeCustomLogger() {
        return {
            debug: (subject) => this.log('debug', subject),
            info: (subject) => this.log('info', subject),
            warn: (subject) => this.log('warn', subject),
            error: (subject) => this.log('error', subject)
        }
    }
    

    connect() {}
    disconnect() {}
    msg(targetid, msg) {}
    notice(targetid, msg) {}
    
    
    /* Environments should emit the following events (arguments are for the listeners):
        error: (error)                                                  An error has occured. The argument is the error message.
        connected: ()                                                   The environment has connected successfully.
        disconnected: ()                                                The environment has disconnected.
        message: (type, message, authorid, channelid, messageObject)    A message was received. type is environment-specific but "regular" and "private" are expected. messageObject is environment-specific.
        messageSent: (targetid, message)                                A message was sent. targetid can be a public or private channel.
        join: (userid, channelid, info)                                 A user has joined the environment. info is an environment-specific map.
        part: (userid, channelid, info)                                 A user has left the environment. info is an environment-specific map.
        gotRole: (userid, roleid, channelid, ischange)                  A user has obtained a role within the current session. channelid can be null.
        lostRole: (userid, roleid, channelid, ischange)                 A user has lost a role within the current session. channelid can be null.
   */
    
    
    idToDisplayName(id) { return null; }
    displayNameToId(displayName) { return null; }
    
    idToMention(id) { return null; }                                    //Convert a user ID into a format most likely to trigger an alert
    
    idIsSecured(id) { return false; }
    idIsAuthenticated(id) { return false; }
    
    listUserIds(channel) { return []; }                                 //List IDs of users in a channel
    
    listUserRoles(id, channel) { return []; }                           //List a specific user's global roles and, if a channel is specified, roles specific to that channel
    
    
    channelIdToDisplayName(channelid) { return null; }
    
    roleIdToDisplayName(roleid) { return null; }
    displayNameToRoleId(displayName) { return null; }
    
    
    normalizeFormatting(text) { return text; }
    applyFormatting(text) { return text; }
    
    stripNormalizedFormatting(text) {
        return text.replace(/__(.*?)__/g, "$1").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1");
    }


    genericErrorHandler(err) {
        if (!err) return;
        this.emit('error', err);
    }

}

module.exports = Environment;
