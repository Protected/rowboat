/* Environment -- This superclass should be extended by all environment implementations. */
'use strict';

const jsonfile = require('jsonfile');
const logger = require('./Logger.js');
const ModernEventEmitter = require('./ModernEventEmitter.js');

class Environment extends ModernEventEmitter {

    get name() { return this._name; }
    get envName() { return this._envName; }


    get requiredParams() { return []; }
    get optionalParams() { return []; }
    
    get sharedModules() { return []; }
    
    constructor(envName, name) {
        super();
    
        this._envName = envName;
        this._name = name;

        this._hasConnected = false;
        
        this._params = {};
        
    }
    
    
    param(key) { return this._params[key]; }
    get params() { return Object.assign({}, this._params); }
    get configfile() { return "config/" + this._name.toLowerCase() + "." + this._envName.toLowerCase() + ".env.json"; }
    
    
    initialize(sharedInstances) {
        var params = {};
        
        //Load and check parameters
        
        var fileName = this.configfile;
        try {
            params = jsonfile.readFileSync(fileName);
            this.log(`Initializing environment of type ${this._envName}.`);
        } catch(e) {
            this.log('error', `Error trying to load the config file ${fileName} because of: ${e}`);
        }

        for (let reqParam of this.requiredParams) {
            if (params[reqParam] !== undefined && params[reqParam] !== null) this._params[reqParam] = params[reqParam];
            if (this._params[reqParam] === undefined) {
                this.log('error', `Failed loading required parameter: ${reqParam}`);
                return false;
            }
        }
        
        for (let optParam of this.optionalParams) {
            if (params[optParam] !== undefined) this._params[optParam] = params[optParam];
            if (this._params[optParam] === undefined) this._params[optParam] = null;
        }
        
        for (let key in params) {
            if (this._params[key] === undefined) this._params[key] = params[key];
        }
        
        this.on('newListener', (type, handler) => {
            this.log('Handler for *' + type + '* added' + (handler.ctx ? ' by |' + handler.ctx.name + '| .' : ''));
        }, this);

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
    
    get hasConnected() {
        return this._hasConnected;
    }

    whenConnected() {
        //Return a promise that is resolved when the environment is connected
        if (this._hasConnected) {
            return Promise.resolve(this);
        } else {
            return new Promise((resolve, reject) => {
                this.on('connected', (env) => {
                    resolve(env);
                });
            });
        }
    }


    connect() {}
    disconnect() {}
    msg(targetid, msg) {}
    notice(targetid, msg) {}
    
    
    /* Environments should emit the following events (arguments are for the listeners):
        error: (error)                                                      An error has occured. The argument is the error message.
        connected: (env)                                                    The environment has connected successfully.
        disconnected: (env)                                                 The environment has disconnected.
        message: (env, type, message, authorid, channelid, messageObject)   A message was received. type is environment-specific but "regular" and "private" are expected. messageObject is environment-specific.
        messageSent: (env, type, targetid, message)                         A message was sent. targetid can be a public or private channel.
        join: (env, userid, channelid, info)                                A user has joined the environment. info is an environment-specific map.
        part: (env, userid, channelid, info)                                A user has left the environment. info is an environment-specific map.
        gotRole: (env, userid, roleid, channelid, ischange)                 A user has obtained a role within the current session. channelid can be null.
        lostRole: (env, userid, roleid, channelid, ischange)                A user has lost a role within the current session. channelid can be null.
   */
    
    
    idToDisplayName(id) { return null; }
    displayNameToId(displayName) { return null; }
    
    idToMention(id) { return null; }                                    //Convert a user ID into a format most likely to trigger an alert
    
    idIsSecured(id) { return false; }
    idIsAuthenticated(id) { return false; }
    
    listUserIds(channel) { return []; }                                 //List IDs of users in a channel
    
    listUserRoles(id, channel) { return []; }                           //List a specific user's global roles and, if a channel is specified, roles specific to that channel
    
    
    channelIdToDisplayName(channelid) { return null; }
    channelIdToType(channelid) { return "regular"; }                    //Obtain a channel's type (compatible with events)
    
    roleIdToDisplayName(roleid) { return null; }
    displayNameToRoleId(displayName) { return null; }
    
    
    normalizeFormatting(text) { return text; }                          //Convert formatting to a cross-environment normalized format
    applyFormatting(text) { return text; }                              //Convert normalized formatting to environment-specific formatting
    
    stripNormalizedFormatting(text) {                                   //Remove normalized formatting
        return text.replace(/__(.*?)__/g, "$1").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1");
    }


    genericErrorHandler(err) {
        if (!err) return;
        this.emit('error', err);
    }

}

module.exports = Environment;
