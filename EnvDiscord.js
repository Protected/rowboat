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

        this.log(`Connecting to ${params.servername}`);

        this._client = new discord.Client({
            apiRequestMethod: 'sequential',
            fetchAllMembers: true
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

            this.log("Environment is now ready!");
        });
        

        this._client.on("message", (message) => {

            if (message.author.username == this._client.user.username) return;

            var type = "regular";
            var channelid = message.channel.id;
            if (message.channel.type == "dm") {
                type = "private";
                channelid = message.author.id;
            }

            this.emit('message', type, message.content, message.author.id, channelid, message);
        });
        
        
        this._client.on("guildMemberAdd", (member) => {
            var chans = this.findAccessChannels(member);
            if (chans.length) {
                this.triggerJoin(member.id, chans, {reason: "add"});
            }
            var roles = member.roles.array();
            for (let role of roles) {
                this.emit('gotRole', member.id, role.id);
            }
        });
        
        
        this._client.on("guildMemberRemove", (member) => {
            if (member.user.presence.status == "offline") return;
            
            var chans = this.findAccessChannels(member);
            if (chans.length) {
                this.triggerPart(member.id, chans, {reason: "remove"});
            }
            var roles = member.roles.array();
            for (let role of roles) {
                this.emit('lostRole', member.id, role.id);
            }
        });
        
        
        this._client.on("guildMemberUpdate", (oldMember, newMember) => {
            if (newMember.user.presence.status == "offline") return;
        
            //Channels
        
            var had = {};
            for (let chan of this.findAccessChannels(oldMember)) {
                had[chan.id] = chan;
            }
            
            var tojoin = [];
            var topart = [];
            
            for (let chan of this.findAccessChannels(newMember)) {
                if (!had[chan.id]) tojoin.push(chan);
                else delete had[chan.id];
            }
            for (let chanid in had) {
                topart.push(had[chanid]);
            }            
        
            if (tojoin.length) {
                this.triggerJoin(newMember.id, tojoin, {reason: "permissions"});
            }
            if (topart.length) {
                this.triggerPart(oldMember.id, topart, {reason: "permissions"});
            }
            
            //Roles
            
            had = {};
            for (let role of oldMember.roles) {
                had[role.id] = role;
            }
            
            var toget = [];
            var tolose = [];
            
            for (let role of newMember.roles) {
                if (!had[role.id]) toget.push(role);
                else delete had[role.id];
            }
            for (let roleid in had) {
                tolose.push(had[roleid]);
            }
            
            for (let role of toget) {
                this.emit('gotRole', newMember.id, role.id, null, true);
            }
            
            for (let role of tolose) {
                this.emit('lostRole', newMember.id, role.id, null, true);
            }
            
        });
        
        
        this._client.on("presenceUpdate", (oldUser, newUser) => {
            var reason = null;
            if (oldUser.presence.status == "offline" && newUser.presence.status != "offline") {
                reason = "join";
            }
            if (oldUser.presence.status != "offline" && newUser.presence.status == "offline") {
                reason = "part";
            }
            if (!reason) return;
            
            var member = this._server.members.get(newUser.id);
            var chans = this.findAccessChannels(member);
            
            if (reason == "join") {
                this.triggerJoin(member.id, chans, {reason: reason, status: newUser.presence.status});
            }
            if (reason == "part") {
                if (member) this.triggerPart(member.id, chans, {reason: reason, status: oldUser.presence.status});
            }
        });
        

        this._client.login(params.token).then(() => {
            this.emit('connected');
        }).catch(this.genericErrorHandler);
        
    }
    
    
    disconnect() {
        if (this._carrier) clearInterval(this._carrier);
        if (this._client) this._client.destroy().then(
            this.carrier = null;
            this.client = null;
            this.log(`Disconnected from ${this._name}`);
            this.emit('disconnected');
        ).catch(this.genericErrorHandler);
    }
    
    
    msg(targetid, msg) {
        var targetchan = this.getActualChanFromTarget(targetid);

        if (!targetchan) {
            targetchan = this._channels[this.param('defaultchannel')];
        }

        this._outbox.push([targetchan, msg]);
    }
    
    
    notice(targetid, msg) {
        this.msg(targetid, msg);
    }
    

    idToDisplayName(id) {
        var member = this._server.members.get(id);
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
    
    
    idToMention(id) {
        return "<@" + id + ">";
    }
    
    
    idIsSecured(id) {
        var member = this._server.members.get(id);
        return !!member;
    }
    
    idIsAuthenticated(id) {
        var member = this._server.members.get(id);
        return !!member;
    }
    
    
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
    
    
    listUserRoles(id, channel) {
        var member = this._server.members.get(id);
        if (!member) return [];
        var result = [];
        var roles = member.roles.array().sort((a, b) => (b.position - a.position));
        for (let role of roles) {
            result.push(role.id);
        }
        return result;
    }
    
    
    channelIdToDisplayName(channelid) {
        var channel = this._server.channels.get(channelid);
        if (channel) return channel.name;
        return channelid;
    }
    
    
    roleIdToDisplayName(roleid) {
        var role = this._server.roles.get(roleid);
        if (role) return role.name;
        return roleid;
    }
    
    
    displayNameToRoleId(displayName) {
        var role = this._server.roles.find('name', displayName);
        if (role) return role.id;
        return null;
    }
    
    
    normalizeFormatting(text) {
        text = String(text).replace(/<@&([0-9]+)>/g, (match, id) => {
            let role = this._server.roles.get(id);
            if (!role) return "";
            return "@" + role.name;
        });
        
        text = text.replace(/<@!?([0-9]+)>/g, (match, id) => {
            let user = this._server.members.get(id);
            if (!user) return "";
            return "@" + (user.nickname ? user.nickname : user.user.username);
        });
        
        text = text.replace(/<#([0-9]+)>/g, (match, id) => {
            let chan = this._server.channels.get(id);
            if (!chan) return "";
            return "#" + chan.name;
        });
    
        return text.replace(/~~(.*?)~~/g, "$1").replace(/(^|[^a-z0-9])_(.*?)_([^a-z0-9]|$)/gi, "$1*$2*$3");
    }
    
    
    applyFormatting(text) {
        //Normalized formatting is already fully compatible with Discord
        return String(text);
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
                {
                    disable_everyone: true,
                    split: {char: "\n"}
                }
            ).catch(this.genericErrorHandler);
            for (let message of packages[rawchannelid].messages) {
                this.emit('messageSent', rawchannelid, message);
            }
        }
        this._outbox = [];
    }
    
    
    get client() { return this._client; }
    get server() { return this._server; }
    
    
    getActualChanFromTarget(targetid) {
        var targetchan = null;

        if (typeof targetid == "string") {
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.channels.filter((channel) => (channel.type == "text")).get(targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.members.get(targetid);
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
    
    
    findAccessChannels(member) {
        var channels = [];
        if (!member) return channels;
        
        var allchannels = member.guild.channels.array();
        for (let channel of allchannels) {
            if (channel.permissionsFor(member).hasPermission("READ_MESSAGES")) {
                channels.push(channel);
            }
        }
        
        return channels;
    }
    
    
    triggerJoin(authorid, channels, info) {
        if (!info) info = {};
        for (let channel of channels) {
            this.emit('join', authorid, channel.id, info);
        }
    }
    
    triggerPart(authorid, channels, info) {
        if (!info) info = {};
        for (let channel of channels) {
            this.emit('part', authorid, channel.id, info);
        }
    }
    
    
};


module.exports = EnvDiscord;
