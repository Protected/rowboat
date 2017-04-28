/* Wrapper that allows multiple environments to use a discord.js client. */

var discord = require('discord.js');
var moment = require('moment');
var ModernEventEmitter = require('./ModernEventEmitter.js');


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
        

        this._realClient.on("message", (message) => {
            this.emit("message", message);
        });
        
        this._realClient.on("messageUpdate", (oldMessage, newMessage) => {
            this.emit("messageUpdate", oldMessage, newMessage);
        });
        
        this._realClient.on("guildMemberAdd", (member) => {
            this.emit("guildMemberAdd", member);
        });
        
        this._realClient.on("guildMemberRemove", (member) => {
            this.emit("guildMemberRemove", member);
        });
        
        this._realClient.on("guildMemberUpdate", (oldMember, newMember) => {
            this.emit("guildMemberUpdate", oldMember, newMember);
        });
        
        this._realClient.on("presenceUpdate", (oldUser, newUser) => {
            this.emit("presenceUpdate", oldUser, newUser);
        });
        
        this._realClient.on("roleUpdate", (oldRole, newRole) => {
            this.emit("presenceUpdate", oldRole, newRole);
        });
        
        this._realClient.on("roleDelete", (role) => {
            this.emit("roleDelete", role);
        });
        
        this._realClient.on("voiceStateUpdate", (oldMember, newMember) => {
            this.emit("voiceStateUpdate", oldMember, newMember);
        });
        
        this._realClient.on("messageReactionAdd", (messageReaction, user) => {
            this.emit("messageReactionAdd", messageReaction, user);
        });
        
        
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
    
        //Merge multiple messages together into packages in order to minimize amount of API calls
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
        
        for (let rawchannelid in packages) {
            
            //Deliver a package to Discord
            packages[rawchannelid].targetchan.send(
                packages[rawchannelid].messages.join("\n"),
                {
                    disable_everyone: true,
                    split: {char: "\n"}
                }
            ).catch();
            
            //List environments that target the server the package was delivered to
            let notifyEnvironments = [];
            for (let name in this._environments) {
                let env = this._environments[name];
                if (env.param('servername') == packages[rawchannelid].targetchan.guild.name) {
                    notifyEnvironments.push(env);
                }
            }
            
            //Trigger messageSent event on listed environments
            for (let message of packages[rawchannelid].messages) {
                setTimeout(() => {
                    for (let env of notifyEnvironments) {
                        env.emit('messageSent', env, env.channelIdToType(packages[rawchannelid].targetchan), rawchannelid, message);
                    }
                }, 1);
            }
        }
        
        this._outbox = [];
    }
    
    
    outbox(discordchan, msg) {
        this._outbox.push([discordchan, msg]);
    }

}

module.exports = new DiscordClient();
