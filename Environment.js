/* Environment -- This superclass should be extended by all environment implementations. */
'use strict';

var jsonfile = require('jsonfile');
var logger = require('./Logger');

class Environment {

    get name() { return this._name; }
    get envName() { return this._envName; }


    get requiredParams() { return []; }
    get optionalParams() { return []; }
    
    constructor(envName, name) {
    
        this._envName = envName;
        this._name = name;
        
        this._params = {};
        
        this._cbError = [];
        this._cbMessage = [];
        this._cbJoin = [];
        this._cbPart = [];
        
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
    
    
    registerOnError(func, self) {
        if (!self) {
            this._cbError.push(func);
        } else {
            this._cbError.push([func, self]);
        }
    }
    
    registerOnMessage(func, self) {
        if (!self) {
            this._cbMessage.push(func);
        } else {
            this._cbMessage.push([func, self]);
        }
    }
    
    registerOnJoin(func, self) {
        if (!self) {
            this._cbJoin.push(func);
        } else {
            this._cbJoin.push([func, self]);
        }
    }
    
    registerOnPart(func, self) {
        if (!self) {
            this._cbPart.push(func);
        } else {
            this._cbPart.push([func, self]);
        }
    }
    
    
    invokeRegisteredCallback(desc, args) {
        if (typeof desc == "function") {
            return desc.apply(this, args);
        } else {
            return desc[0].apply(desc[1], args);
        }
    }
    
    
    idToDisplayName(id) { return null; }
    displayNameToId(displayName) { return null; }
    
    idToMention(id) { return null; }
    
    idIsSecured(id) { return false; }
    idIsAuthenticated(id) { return false; }
    
    listUserIds(channel) { return []; }
    
    
    channelIdToDisplayName(channelid) { return null; }
    
    
    normalizeFormatting(text) { return text; }
    applyFormatting(text) { return text; }
    
    stripNormalizedFormatting(text) {
        return text.replace(/__(.*?)__/g, "$1").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1");
    }


    genericErrorHandler(err) {
        if (!err) return;
        for (let callback of this._cbError) {
            let result;
            logger.debug(`Checking for ${callback}`);
            if (typeof callback == "function") {
                logger.debug(`It was a function.`);
                result = callback(this, err);
            } else {
                logger.debug(`It was not a function.`);
                result = callback[0].apply(callback[1], [this, err]);
            }
            logger.debug(`Result was ${result}`);
            if (result) {
                break;
            }
        }
    }

}

module.exports = Environment;
