/* Environment: Discord -- This environment connects to a Discord server/guild. */

var Environment = require('./Environment.js');
var discord = require('discord.js');

class EnvDiscord extends Environment {


    get requiredParams() { return [
        'token',                //Discord application token
        'servername',           //Server name to operate on (application must have been previously added to server)
        'defaultchannel'        //Default channel to operate on (must be a channel in the above server)
    ]; }
        
    get optionalParams() { return [
        'senddelay'             //Message queue send delay (ms)
    ]; }

    constructor(name) {
        super('Discord', name);

        this._params['senddelay'] = 500;
        
        this._client = null;
        this._server = null;
        this._channels = {};
        this._outbox = [];
        this._carrier = null;
    }
    
    
    connect() {
    
        var params = this.params;
    
        this._client = new discord.Client();

        this._client.on("ready", (message) => {
            this._server = this._client.servers.get("name", params.servername);
            
            this._channels[this._server.defaultChannel.name] = this._server.defaultChannel;
            if (params.defaultchannel != this._server.defaultChannel.name) {
                this._channels[params.defaultchannel] = this._server.channels.getAll("type", "text").get("name", params.defaultchannel);
            }
            
            this._carrier = setInterval(this.deliverMsgs, params.senddelay);
        });

        this._client.on("message", (message) => {

            if (message.author.username == this._client.user.username) return;

            var type = "regular";
            var channelid = message.channel.id;
            if (message.channel instanceof discord.PMChannel) {
                type = "private";
                channelid = message.author.id;
            }

            for (let callback of this._cbMessage) {
                if (callback(this, type, message.content, message.author.id, channelid, message)) {
                    break;
                }
            }
            
        });

        this._client.loginWithToken(params.token, Environment.genericErrorHandler);
        
    }
    
    
    disconnect() {
        if (this._carrier) clearInterval(this._carrier);
        if (this._client) this._client.logout(Environment.genericErrorHandler);
        this.carrier = null;
        this.client = null;
    }
    
    
    msg(targetid, msg) {
        var targetchan = null;

        if (typeof targetid == "string") {
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.channels.getAll("type", "text").get("id", targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.members.get("id", targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.channels.getAll("type", "text").get("name", targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.members.get("name", targetid);
            }
            if (this._channels[targetid]) {
                targetchan = this._channels[targetid];
            }
        } else {
            targetchan = targetid;
        }

        if (!targetchan) {
            targetchan = this._channels[this.param('defaultchannel')];
        }

        this._outbox.push([targetchan, msg]);
    }
    

    idToDisplayName(id) {
        var user = this._server.members.get("id", id);
        if (user) {
            var disp = this._server.detailsOfUser(user).nick;
            if (!disp) disp = user.username;
            return disp;
        }
        return id;
    }
    
    
    displayNameToId(displayname) {
        var refuser = null;

        var parts = displayname.split("#");
        if (parts[1]) {
            refuser = this._server.members.getAll("username", parts[0]).get("discriminator", parts[1]);
        } else {
            var cache = this._server.members.getAll("username", displayname);
            if (cache.length == 1) {
                refuser = cache[0];
            } else {
                displayname = displayname.toLowerCase();
                for (let member of this._server.members) {
                    var nick = this._server.detailsOfUser(member).nick;
                    if (nick && nick.toLowerCase() == displayname) {
                        refuser = member;
                        break;
                    }
                }
            }
        }

        if (refuser) {
            return refuser.id;
        }

        return null;
    }
    
    
    idIsSecured(id) { return true; }
    idIsAuthenticated(id) { return true; }
    
    
    //Auxiliary methods
    
    deliverMsgs() {
        var packages = {};
        for (var i = 0; this.outbox && i < this.outbox.length; i++) {
            var rawchannelid = this.outbox[i][0].id;
            if (!packages[rawchannelid]) {
                packages[rawchannelid] = {
                    targetchan: this.outbox[i][0],
                    messages: []
                }
            }
            packages[rawchannelid].messages.push(this.outbox[i][1]);
        }
        for (var rawchannelid in packages) {
            try {
                this.client.sendMessage(
                    packages[rawchannelid].targetchan,
                    packages[rawchannelid].messages.join("\n"),
                    {disableEveryone: true},
                    this.genericErrorHandler
                );
            } catch (e) {
                this.genericErrorHandler(e.message);
            }
        }
        this.outbox = [];
    }
    
    
    get server() { return this._server; }
    
    
};


module.exports = EnvDiscord;
