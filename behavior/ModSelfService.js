/* Module: SelfService -- Commands for a user to register his own account. */

const Module = require('../Module.js');
const random = require('meteor-random');
const moment = require('moment');
const md5 = require('js-md5');

const tokenChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';


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


    initialize(opt) {
        if (!super.initialize(opt)) return false;
        
        var self = this;
        
        if (this.param('idLinkage')) {
            this._tokenCleaner = setInterval(() => {
                self.clearTokens.apply(self, null);
            }, 60000);
        }
        
        
        //Register callbacks
        
        this.mod("Commands").registerCommand(this, 'whoami', {
            description: 'If I am authenticated, shows the details of my account.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
    
            if (!handle) {
                ep.reply("You don't have an account. Your ID in " + env.name + " is: " + userid);
            }
    
            let account = this.mod("Users").getUser(handle);
            if (!account) return true;
            
            ep.reply('========== __' + account.handle + '__ ==========');
            
            ep.reply('* ID patterns:');
            if (account.ids) {
                for (let i = 0; i < account.ids.length; i++) {
                    ep.reply('    {' + account.ids[i].env + '} `' + account.ids[i].idpattern + '`');
                }
            }
            
            ep.reply('* Permissions:');
            let perms = account.perms;
            if (perms) {
                while (perms.length) {
                    let outbound = perms.slice(0, 10);
                    outbound = outbound.join(', ');
                    ep.reply('    ' + outbound);
                    perms = perms.slice(10);
                }
            }
        
            return true;
        });
        
        
        if (this.param('enableSelfRegistration')) {
            this.mod("Commands").registerCommand(this, 'register', {
                description: 'If I am not authenticated, registers an account associated with the current ID.',
                args: ['handle']
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                if (handle) {
                    ep.reply("You already have an account! Your handle is: " + handle + ".");
                    return true;
                }
                
                if (!env.idIsSecured(userid) || !env.idIsAuthenticated(userid)) {
                    ep.reply("Your connection to this environment (" + env.name + ") is not secured or not authenticated. Please try again using a secured and authenticated connection.");
                    return true;
                }
                
                let existingaccount = this.mod("Users").getUser(args.handle);
                if (existingaccount) {
                    ep.reply("There is already an account identified by the handle you provided.");
                    return true;
                }
                
                if (!this.mod("Users").addUser(args.handle)) {
                    ep.reply("Failed to create user account " + args.handle + ".");
                    return true;
                }
                
                if (!this.mod("Users").addId(args.handle, env.name, "^" + userid + "$")) {
                    this.mod("Users").delUser(args.handle);
                    ep.reply("Failed to initialize your new account with your current " + env.name + " ID.");
                    return true;
                }
                
                ep.reply("Your account '" + args.handle + "' was successfully created!");
                
                if (this.param("initializeWithPermissions").length && this.mod("Users").addPerms(args.handle, this.param("initializeWithPermissions"))) {
                    ep.reply("Initial permissions: " + this.param("initializeWithPermissions").join(", "));
                }
            
                return true;
            });
        }
        
        
        if (this.param('idLinkage')) {
            this.mod("Commands").registerCommand(this, 'link', {
                description: 'Create a token for linking your current ID or pass a previously created token to link it with your current account.',
                args: ["token"],
                minArgs: 0,
                permissions: (typeof this.param('idLinkage') == "string" ? [this.param('idLinkage')] : null),
                types: ["private"]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                if (args.token) {
                
                    if (!handle) {
                        ep.reply("You are not authenticated with an account!");
                        return true;
                    }
                    
                    let descriptor = this._tokens[args.token];
                    if (!descriptor) {
                        ep.reply("Your token is invalid or has expired. Please try again.");
                        return true;
                    }
                    
                    let handles = this.mod("Users").getHandlesById(descriptor.env.name, descriptor.id);
                    if (handles.length) {
                        this.deleteToken(args.token);
                        ep.reply("This ID has already been assigned to an account: " + handles[0]);
                        return true;
                    }
                    
                    if (!this.mod("Users").addId(handle, descriptor.env.name, "^" + descriptor.id + "$")) {
                        ep.reply("Failed to assign the new ID to your account. Please try again.");
                        return true;
                    }
                    
                    this.deleteToken(args.token);
                    ep.reply("Successfully linked " + descriptor.id + " in " + descriptor.env.name + " with your account!");
                
                } else {
                
                    if (handle) {
                        ep.reply("You already have an account! Your handle is: " + handle + ".");
                        return true;
                    }
                    
                    if (!env.idIsSecured(userid) || !env.idIsAuthenticated(userid)) {
                        ep.reply("Your connection to this environment (" + env.name + ") is not secured or not authenticated. Please try again using a secured and authenticated connection.");
                        return true;
                    }
                
                    if (this._index[md5(env.name + ' ' + userid)]) {
                        ep.reply("A previously generated token is active for your ID. You should now authenticate with your account and use 'link TOKEN'.");
                        return true;
                    }
                
                    let token = this.createToken(env, userid);
                    ep.reply("Your token: " + token);
                    ep.reply("Please authenticate with an existing account and use the 'link TOKEN' command to link your current ID to it.");
                
                }
            
                return true;
            });
        }
        
        
        return true;
    }
    
    
    // # Module code below this line #
    
    
    createToken(env, id) {
        let token = null;
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
        let now = moment().unix();
        
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
