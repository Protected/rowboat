/* Environment -- This superclass should be extended by all environment implementations. */

var jsonfile = require('jsonfile');

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
        
    }
    
    
    param(key) { return this._params[key]; }
    get params() { return Object.assign({}, this._params); }
    
    
    initialize() {
        var params = {};

        try {
            params = jsonfile.readFileSync("config/" + this._name.toLowerCase() + "." + this._envName.toLowerCase() + ".env.json");
        } catch(e) {}

        for (let reqParam of this.requiredParams) {
            if (params[reqParam]) this._params[reqParam] = params[reqParam];
            if (this._params[reqParam] === undefined) return false;
        };
        
        for (let optParam of this.optionalParams) {
            if (params[optParam]) this._params[optParam] = params[optParam];
            if (this._params[optParam] === undefined) this._params[optParam] = null;
        }

        return true;
    }
    

    connect() {}
    disconnect() {}
    msg(targetid, msg) {}
    
    
    registerOnError(func) {
        this._cbError.push(func);
    }
    
    registerOnMessage(func) {
        this._cbMessage.push(func);
    }
    
    
    idToDisplayName(id) { return null; }
    displayNameToId(displayName) { return null; }
    
    idIsSecured(id) { return false; }
    idIsAuthenticated(id) { return false; }


    static genericErrorHandler(err) {
        if (!err) return;
        for (let callback of this._cbError) {
            if (callback(this, err)) {
                break;
            }
        }
    }

}

module.exports = Environment;
