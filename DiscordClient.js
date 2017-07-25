/* Wrapper that allows multiple environments to use a discord.js client. */

var discord = require('discord.js');
var moment = require('moment');
var ModernEventEmitter = require('./ModernEventEmitter.js');

const BRIDGE_EVENTS = [
    "message",
    "messageUpdate",
    "guildMemberAdd",
    "guildMemberRemove",
    "guildMemberUpdate",
    "presenceUpdate",
    "presenceUpdate",
    "roleDelete",
    "voiceStateUpdate", 
    "messageReactionAdd"
];

class DiscordClient extends ModernEventEmitter {

    constructor() {
        super();
    
        this._environments = {};

        this._realClient = null;
        this._resolveOnLogin = [];
        
        this._outbox = [];
        this._carrier = null;
        
        this._sendDelay = 500;
        this._token = null;
    }
    
    
    get realClient() {
        return this._realClient;
    }
    
    
    prepareClient(envDiscord, token, sendDelay) {
        this._sendDelay = sendDelay;
        
        this._environments[envDiscord.name] = envDiscord;
        
        if (this._realClient) {   
            return new Promise((resolve) => {
                this._resolveOnLogin.push(resolve);
            });
        }
        
        this._token = token;
        
        this._realClient = new discord.Client({
            apiRequestMethod: 'sequential',
            fetchAllMembers: true
        });
        
        this._realClient.on('error', (error) => {
            for (let name in this._environments) {
                this._environments[name].emit('error', 'Serious connection error: ' + error.message);
            }
        });
        
        for (let event of BRIDGE_EVENTS) {
            this._realClient.on(event, (...args) => {
                args.unshift(event);
                this.emit.apply(this, args);
            });
        }
        
        let self = this;
        return this._realClient.login(this._token)
            .then(() => {
                this._carrier = setInterval(() => {
                    self.deliverMsgs.apply(self, null);
                }, this._sendDelay);
                
                for (let resolve of this._resolveOnLogin) {
                    resolve(this._realClient);
                }
                
                return this._realClient;
            });
    }
    
    
    detachFromClient(envDiscord) {
        if (!this._environments[envDiscord.name]) return Promise.resolve();
        delete this._environments[envDiscord.name];
        if (Object.keys(this._environments).length) return Promise.resolve();
        return this._realClient.destroy()
            .then(() => {
                if (this._carrier) {
                    clearInterval(this._carrier);
                    this._carrier = null;
                }
                this._realClient = null;
            });
    }
    
    
    deliverMsgs() {
        if (!this._outbox.length) return;
    
        //Merge multiple messages together into packages in order to minimize amount of API calls (one package per channel)
        let packages = {};
        for (let i = 0; this._outbox && i < this._outbox.length; i++) {
            let rawchannelid = this._outbox[i][0].id;
            if (!packages[rawchannelid]) {
                packages[rawchannelid] = {
                    targetchan: this._outbox[i][0],
                    messages: []
                }
            }
            packages[rawchannelid].messages.push(this._outbox[i][1]);
        }
        
        let newOutbox = [];
        
        for (let rawchannelid in packages) {
            let pack = packages[rawchannelid];
            
            //The message (as delivered to Discord) must end at the first RichEmbed (API only supports one per message)
            let msgparts = [];
            let embed = null;
            for (let message of pack.messages) {
                if (embed) {
                    newOutbox.push([pack.targetchan, message]);
                } else if (typeof message == "string" || typeof message == "number") {
                    msgparts.push(message);
                } else if (typeof message == "object") {
                    embed = message;
                }
            }
            
            //Deliver message to Discord
            pack.targetchan.send(
                msgparts.join("\n"),
                {
                    disable_everyone: true,
                    split: {char: "\n"},
                    embed: embed
                }
            ).catch();
            
            //List environments that target the server the package was delivered to
            let notifyEnvironments = [];
            for (let name in this._environments) {
                let env = this._environments[name];
                if (env.param('servername') == pack.targetchan.guild.name) {
                    notifyEnvironments.push(env);
                }
            }
            
            //Trigger messageSent event on listed environments
            for (let message of msgparts) {
                setTimeout(() => {
                    for (let env of notifyEnvironments) {
                        env.emit('messageSent', env, env.channelIdToType(pack.targetchan), rawchannelid, message);
                    }
                }, 1);
            }
            
        }
        
        this._outbox = newOutbox;
    }
    
    
    //Outbox a string or RichEmbed
    outbox(discordchan, msg) {
        this._outbox.push([discordchan, msg]);
    }

}

module.exports = new DiscordClient();
