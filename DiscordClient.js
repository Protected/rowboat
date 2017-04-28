/* Wrapper that allows multiple environments to use a discord.js client. */

var discord = require('discord.js');
var moment = require('moment');

class DiscordClient {

    constructor() {
        this._environments = {};

        this._realClient = null;
        this._outbox = [];
        this._carrier = null;
        
        this._sendDelay = 500;
        this._token = null;
    }
    
    
    prepareClient(envDiscord, token, sendDelay) {
        this._sendDelay = sendDelay;
        
        this._environments[envDiscord.name] = envDiscord;
        
        if (this._realClient) {
            return Promise.resolve(this._realClient);
        }
        
        this._token = token;
        
        this._realClient = new discord.Client({
            apiRequestMethod: 'sequential',
            fetchAllMembers: true
        });
        
        this._realClient.on('error', (error) => {
            for (let env of notifyEnvironments) {
                env.emit('error', 'Serious connection error: ' + error.message);
            }
        });
        
        let self = this;
        return this._realClient.login(this._token)
            .then(() => {
                this._carrier = setInterval(() => {
                    self.deliverMsgs.apply(self, null);
                }, this._sendDelay);
            })
            .then(() => this._realClient);
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
