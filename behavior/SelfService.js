/* SelfService -- Commands for regular users to register and merge bot accounts. */

import random from 'meteor-random';
import moment from 'moment';
import md5 from 'js-md5';

import Behavior from '../src/Behavior.js';

const tokenChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export default class SelfService extends Behavior {

    get params() { return [
        {n: 'enableSelfRegistration', d: "Enable !register"},
        {n: 'enableIdLinkage', d: "Enable !link (true or a)"},
        {n: 'initializeWithPermissions', d: "Permissions for newly registered accounts (list)"},
        {n: 'tokenLength', d: "Length of !link tokens"},
        {n: 'tokenExpiration', d: "Validity of !link tokens (s)"}
    ]; }

    get defaults() { return {
        enableSelfRegistration: false,
        enableIdLinkage: true,
        initializeWithPermissions: [],
        tokenLength: 32,
        tokenExpiration: 300
    }; }
    
    get requiredBehaviors() { return {
        Users: 'Users',
        Commands: 'Commands'
    }; }

    constructor(name) {
        super('SelfService', name);
        
        this._tokens = {};
        this._index = {};
        
        //Timer
        this._tokenCleaner = null;
    }


    initialize(opt) {
        if (!super.initialize(opt)) return false;
        
        var self = this;
        
        if (this.param('enableIdLinkage')) {
            this._tokenCleaner = setInterval(() => {
                self.clearTokens.apply(self, null);
            }, 60000);
        }
        
        
        //Register callbacks
        
        this.be("Commands").registerCommand(this, 'whoami', {
            description: 'If I am authenticated, shows the details of my account.'
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
    
            if (!handle) {
                ep.reply("You don't have an account. Your ID in " + env.name + " is: " + userid);
            }
    
            let account = await this.be("Users").getUser(handle);
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
            this.be("Commands").registerCommand(this, 'register', {
                description: 'If I am not authenticated, registers an account associated with the current ID.',
                args: ['handle']
            }, async(env, type, userid, channelid, command, args, handle, ep) => {
            
                if (handle) {
                    ep.reply("You already have an account! Your handle is: " + handle + ".");
                    return true;
                }
                
                if (!env.idIsSecured(userid) || !env.idIsAuthenticated(userid)) {
                    ep.reply("Your connection to this environment (" + env.name + ") is not secured or not authenticated. Please try again using a secured and authenticated connection.");
                    return true;
                }
                
                let existingaccount = await this.be("Users").getUser(args.handle);
                if (existingaccount) {
                    ep.reply("There is already an account identified by the handle you provided.");
                    return true;
                }
                
                if (!await this.be("Users").addUser(args.handle)) {
                    ep.reply("Failed to create user account '" + args.handle + "'.");
                    return true;
                }
                
                if (!await this.be("Users").addId(args.handle, env.name, "^" + userid + "$")) {
                    await this.be("Users").delUser(args.handle);
                    ep.reply("Failed to initialize your new account with your current " + env.name + " ID.");
                    return true;
                }
                
                ep.reply("Your account '" + args.handle + "' was successfully created!");
                
                if (this.param("initializeWithPermissions").length && await this.be("Users").addPerms(args.handle, this.param("initializeWithPermissions"))) {
                    ep.reply("Initial permissions: " + this.param("initializeWithPermissions").join(", "));
                }
            
                return true;
            });
        }
        
        
        if (this.param('enableIdLinkage')) {
            this.be("Commands").registerCommand(this, 'link', {
                description: 'Create a token for linking your current ID or pass a previously created token to link it with your current account.',
                args: ["token"],
                minArgs: 0,
                types: ["private"]
            }, async (env, type, userid, channelid, command, args, handle, ep) => {
            
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
                    
                    let handles = await this.be("Users").getHandlesById(descriptor.env.name, descriptor.id);
                    if (handles.length) {
                        this.deleteToken(args.token);
                        ep.reply("This ID has already been assigned to an account: " + handles[0]);
                        return true;
                    }
                    
                    if (!await this.be("Users").addId(handle, descriptor.env.name, "^" + descriptor.id + "$")) {
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
