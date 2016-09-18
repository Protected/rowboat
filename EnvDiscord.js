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
    
        var self = this;
        var params = this.params;
    
        this._client = new discord.Client({
            api_request_method: 'sequential',
            fetch_all_members: true
        });
        
        this._client.on("ready", () => {
            this._server = this._client.guilds.find("name", params.servername);
            
            this._channels[this._server.defaultChannel.name] = this._server.defaultChannel;
            if (params.defaultchannel != this._server.defaultChannel.name) {
                this._channels[params.defaultchannel] = this._server.channels.filter((channel) => (channel.type == "text")).find("name", params.defaultchannel);
            }

            this._carrier = setInterval(() => {
                    self.deliverMsgs.apply(self, null)
                }, params.senddelay);
        });

        this._client.on("message", (message) => {

            if (message.author.username == this._client.user.username) return;

            var type = "regular";
            var channelid = message.channel.id;
            if (message.channel.type == "dm") {
                type = "private";
                channelid = message.author.id;
            }

            for (let callback of this._cbMessage) {
                if (this.invokeRegisteredCallback(callback, [this, type, message.content, message.author.id, channelid, message])) {
                    break;
                }
            }
            
        });

        this._client.login(params.token).catch(this.genericErrorHandler);
        
    }
    
    
    disconnect() {
        if (this._carrier) clearInterval(this._carrier);
        if (this._client) this._client.destroy().catch(this.genericErrorHandler);
        this.carrier = null;
        this.client = null;
    }
    
    
    getActualChanFromTarget(targetid) {
        var targetchan = null;

        if (typeof targetid == "string") {
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.channels.filter((channel) => (channel.type == "text")).find("id", targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.members.find("id", targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.channels.filter((channel) => (channel.type == "text")).find("name", targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.members.find("name", targetid);
            }
            if (this._channels[targetid]) {
                targetchan = this._channels[targetid];
            }
        } else {
            targetchan = targetid;
        }
        
        return targetchan;    
    }
    
    msg(targetid, msg) {
        var targetchan = this.getActualChanFromTarget(targetid);

        if (!targetchan) {
            targetchan = this._channels[this.param('defaultchannel')];
        }

        this._outbox.push([targetchan, msg]);
    }
    

    idToDisplayName(id) {
        var member = this._server.members.find("id", id);
        if (member) return (member.nickname ? member.nickname : member.user.username);
        return id;
    }
    
    
    displayNameToId(displayname) {
        var refuser = null;

        var parts = displayname.split("#");
        if (parts[1]) {
            refuser = this._server.members.filter((member) => (member.user.username == parts[0])).find("user.discriminator", parts[1]);
        } else {
            var cache = this._server.members.filter((member) => (member.user.username == displayname)).array();
            if (cache.length == 1) {
                refuser = cache[0];
            } else {
                displayname = displayname.toLowerCase();
                refuser = this._server.members.find((member) => (member.nickname && member.nickname.toLowerCase() == displayname));
            }
        }

        if (refuser) {
            return refuser.id;
        }

        return null;
    }
    
    
    idIsSecured(id) { return true; }
    idIsAuthenticated(id) { return true; }
    
    
    listUserIds(channel) {
        var targetchan = this.getActualChanFromTarget(channel);
        if (!targetchan) {
            targetchan = this._channels[this.param('defaultchannel')];
        }
        
        if (targetchan.type == "dm") return [targetchan.recipient.id];
        
        var ids = [];
        if (targetchan.type == "group") {
            for (let user of targetchan.recipients.array()) {
                ids.push(user.id);
            }
        }
        if (targetchan.type == "text") {
            for (let member of targetchan.members.array()) {
                ids.push(member.id);
            }
        }
        
        return ids;
    }
    
    
    //Auxiliary methods
    
    deliverMsgs() {
        var packages = {};
        for (var i = 0; this._outbox && i < this._outbox.length; i++) {
            var rawchannelid = this._outbox[i][0].id;
            if (!packages[rawchannelid]) {
                packages[rawchannelid] = {
                    targetchan: this._outbox[i][0],
                    messages: []
                }
            }
            packages[rawchannelid].messages.push(this._outbox[i][1]);
        }
        for (var rawchannelid in packages) {
            packages[rawchannelid].targetchan.sendMessage(
                packages[rawchannelid].messages.join("\n"),
                {disable_everyone: true, split: true}
            ).catch(this.genericErrorHandler);
        }
        this._outbox = [];
    }
    
    
    get server() { return this._server; }
    
    
};


module.exports = EnvDiscord;
