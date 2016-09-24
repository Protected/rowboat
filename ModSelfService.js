/* Module: SelfService -- Commands for a user to register his own account. */

var Module = require('./Module.js');
var random = require('meteor-random');
var moment = require('moment');
var md5 = require('js-md5');

var tokenChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';


class ModSelfService extends Module {


    get optionalParams() { return [
        'enableSelfRegistration',       //Enable !register
        'idLinkage',                    //Enable !link
        'initializeWithPermissions',    //Permissions for newly registered accounts
        'tokenLength',                  //Length of !link tokens
        'tokenExpiration'               //Validity of !link tokens
    ]; }
    
    get requiredModules() { return [
        'Users',
        'Commands'
    ]; }

    constructor(name) {
        super('SelfService', name);
        
        this._params['enableSelfRegistration'] = false;
        this._params['idLinkage'] = true;  //Pass a string to require a permission
        this._params['initializeWithPermissions'] = [];
        
        this._params['tokenLength'] = 32;
        this._params['tokenExpiration'] = 300;  //s
        
        this._tokens = {};
        this._index = {};
        
        //Timer
        this._tokenCleaner = null;
    }


    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;
        
        var self = this;
        
        if (this.param('idLinkage')) {
            this._tokenCleaner = setInterval(() => {
                self.clearTokens.apply(self, null);
            }, 60000);
        }
        
        
        //Register callbacks
        
        this.mod("Commands").registerCommand('whoami', {
            description: 'If I am authenticated, shows the details of my account.'
        }, (env, type, userid, command, args, handle, reply) => {
    
            if (!handle) {
                reply("You don't have an account. Your ID in " + env.name + " is: " + userid);
            }
    
            var account = this.mod("Users").getUser(handle);
            if (!account) return true;
            
            reply('========== ' + account.handle + ' ==========');
            
            reply('* ID patterns:');
            if (account.ids) {
                for (var i = 0; i < account.ids.length; i++) {
                    reply('    {' + account.ids[i].env + '} `' + account.ids[i].idpattern + '`');
                }
            }
            
            reply('* Permissions:');
            var perms = account.perms;
            if (perms) {
                while (perms.length) {
                    var outbound = perms.slice(0, 10);
                    outbound = outbound.join(', ');
                    reply('    ' + outbound);
                    perms = perms.slice(10);
                }
            }
        
            return true;
        });
        
        
        if (this.param('enableSelfRegistration')) {
            this.mod("Commands").registerCommand('register', {
                description: 'If I am not authenticated, registers an account associated with the current ID.',
                args: ['handle']
            }, (env, type, userid, command, args, handle, reply) => {
            
                if (handle) {
                    reply("You already have an account! Your handle is: " + handle + ".");
                    return true;
                }
                
                if (!env.idIsSecured(userid) || !env.idIsAuthenticated(userid)) {
                    reply("Your connection to this environment (" + env.name + ") is not secured or not authenticated. Please try again using a secured and authenticated connection.");
                    return true;
                }
                
                var existingaccount = this.mod("Users").getUser(args.handle);
                if (existingaccount) {
                    reply("There is already an account identified by the handle you provided.");
                    return true;
                }
                
                if (!this.mod("Users").addUser(args.handle)) {
                    reply("Failed to create user account " + args.handle + ".");
                    return true;
                }
                
                if (!this.mod("Users").addId(args.handle, env.name, "^" + userid + "$")) {
                    this.mod("Users").delUser(args.handle);
                    reply("Failed to initialize your new account with your current " + env.name + " ID.");
                    return true;
                }
                
                reply("Your account '" + args.handle + "' was successfully created!");
                
                if (this.param("initializeWithPermissions").length && this.mod("Users").addPerms(args.handle, this.param("initializeWithPermissions"))) {
                    reply("Initial permissions: " + this.param("initializeWithPermissions").join(", "));
                }
            
                return true;
            });
        }
        
        
        if (this.param('idLinkage')) {
            this.mod("Commands").registerCommand('link', {
                description: 'Create a token for linking your current ID or pass a previously created token to link it with your current account.',
                args: ["token"],
                minArgs: 0,
                permissions: (typeof this.param('idLinkage') == "string" ? [this.param('idLinkage')] : null),
                types: ["private"]
            }, (env, type, userid, command, args, handle, reply) => {
            
                if (args.token) {
                
                    if (!handle) {
                        reply("You are not authenticated with an account!");
                        return true;
                    }
                    
                    let descriptor = this._tokens[args.token];
                    if (!descriptor) {
                        reply("Your token is invalid or has expired. Please try again.");
                        return true;
                    }
                    
                    var handles = this.mod("Users").getHandlesById(descriptor.env.name, descriptor.id);
                    if (handles.length) {
                        this.deleteToken(args.token);
                        reply("This ID has already been assigned to an account: " + handles[0]);
                        return true;
                    }
                    
                    if (!this.mod("Users").addId(handle, descriptor.env.name, "^" + descriptor.id + "$")) {
                        reply("Failed to assign the new ID to your account. Please try again.");
                        return true;
                    }
                    
                    this.deleteToken(args.token);
                    reply("Successfully linked " + descriptor.id + " in " + descriptor.env.name + " with your account!");
                
                } else {
                
                    if (handle) {
                        reply("You already have an account! Your handle is: " + handle + ".");
                        return true;
                    }
                    
                    if (!env.idIsSecured(userid) || !env.idIsAuthenticated(userid)) {
                        reply("Your connection to this environment (" + env.name + ") is not secured or not authenticated. Please try again using a secured and authenticated connection.");
                        return true;
                    }
                
                    if (this._index[md5(env.name + ' ' + userid)]) {
                        reply("A previously generated token is active for your ID. You should now authenticate with your account and use 'link TOKEN'.");
                        return true;
                    }
                
                    var token = this.createToken(env, userid);
                    reply("Your token: " + token);
                    reply("Please authenticate with an existing account and use the 'link TOKEN' command to link your current ID to it.");
                
                }
            
                return true;
            });
        }
        
        
        return true;
    }
    
    
    // # Module code below this line #
    
    
    createToken(env, id) {
        var token = null;
        while (!token || this._tokens[token]) {
            token = '';
            for (let i = 0; i < this.param('tokenLength'); i++) {
                token += tokenChars[Math.floor(random.fraction() * tokenChars.length)];
            }
        }
        
        this._tokens[token] = {
            token: token,
            env: env,
            id: id,
            ts: moment().unix()
        };
        
        this._index[md5(env.name + ' ' + this._tokens[token].id)] = this._tokens[token];
    
        return token;
    }
    
    
    clearTokens() {
        var now = moment().unix();
        
        for (let token in this._tokens) {
            if (now - this._tokens[token].ts >= this.param('tokenExpiration')) {
                this.deleteToken(token);
            }
        }
    }
    
    deleteToken(token) {
        delete this._index[md5(this._tokens[token].env.name + ' ' + this._tokens[token].id)];
        delete this._tokens[token];
    }


}


module.exports = ModSelfService;
