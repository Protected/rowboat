/* Environment: Discord -- This environment connects to a Discord server/guild. */

var Environment = require('./Environment.js');


class EnvDiscord extends Environment {


    get requiredParams() { return [
        'token',                //Discord application token
        'servername',           //Server name to operate on (application must have been previously added to server)
        'defaultchannel',       //Default channel to operate on (must be a channel in the above server)
        'privatemessages'       //Environment will receive private messages to the bot
    ]; }
        
    get optionalParams() { return [
        'senddelay'             //Message queue send delay (ms)
    ]; }
    
    get sharedModules() { return [
        'DiscordClient'
    ]; }

    constructor(name) {
        super('Discord', name);

        this._params['senddelay'] = 500;
        
        this._localClient = null;  //DiscordClient (manages shared discord.js Client object)
        this._client = null;  //Actual discord.js Client object
        this._server = null;  //discord.js Guild object (formerly Server) for the server identified by this environment's 'servername'.
        this._channels = {};
    }
    
    
    initialize(sharedInstances) {
        if (!super.initialize(sharedInstances)) return false;
        this._localClient = sharedInstances.DiscordClient;
        return true;
    }
    
    
    connect() {

        var self = this;
        var params = this.params;

        this.log(`Connecting to ${params.servername}`);

        this._localClient.prepareClient(this, this.param('token'), this.param('sendDelay'))
            .then((client) => {
                this._client = client;
                this._server = client.guilds.find("name", params.servername);
                
                this._channels[this._server.defaultChannel.name] = this._server.defaultChannel;
                if (params.defaultchannel != this._server.defaultChannel.name) {
                    this._channels[params.defaultchannel] = this._server.channels.filter((channel) => (channel.type == "text")).find("name", params.defaultchannel);
                }
                
                
                this._localClient.on("message", (message) => {
                    if (message.author.username == client.user.username) return;
                    
                    var type = "regular";
                    var channelid = message.channel.id;
                    
                    if (message.channel.type == "dm") {
                        if (!this.param('privatemessages')) return;
                        type = "private";
                        channelid = message.author.id;
                    } else {
                        if (message.channel.guild.id != this._server.id) return;
                    }

                    this.emit('message', this, type, message.content, message.author.id, channelid, message);
                });
                
                
                this._localClient.on("guildMemberAdd", (member) => {
                    if (member.guild.id != this._server.id) return;
                    var chans = this.findAccessChannels(member);
                    if (chans.length) {
                        this.triggerJoin(member.id, chans, {reason: "add"});
                    }
                    var roles = member.roles.array();
                    for (let role of roles) {
                        this.emit('gotRole', this, member.id, role.id);
                    }
                });
                
                
                this._localClient.on("guildMemberRemove", (member) => {
                    if (member.user.presence.status == "offline") return;
                    if (member.guild.id != this._server.id) return;
                    
                    var chans = this.findAccessChannels(member);
                    if (chans.length) {
                        this.triggerPart(member.id, chans, {reason: "remove"});
                    }
                    var roles = member.roles.array();
                    for (let role of roles) {
                        this.emit('lostRole', this, member.id, role.id);
                    }
                });
                
                
                this._localClient.on("guildMemberUpdate", (oldMember, newMember) => {
                    if (newMember.user.presence.status == "offline") return;
                    if (newMember.guild.id != this._server.id) return;
                
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
                        this.emit('gotRole', this, newMember.id, role.id, null, true);
                    }
                    
                    for (let role of tolose) {
                        this.emit('lostRole', this, newMember.id, role.id, null, true);
                    }
                    
                });
                
                
                this._localClient.on("presenceUpdate", (oldUser, newUser) => {
                    var reason = null;

                    if (!oldUser.presence || !newUser.presence) return;

                    if (oldUser.presence.status == "offline" && newUser.presence.status != "offline") {
                        reason = "join";
                    }
                    if (oldUser.presence.status != "offline" && newUser.presence.status == "offline") {
                        reason = "part";
                    }
                    if (!reason) return;
                    
                    var member = this._server.members.get(newUser.id);
                    if (!member) return;
                    var chans = this.findAccessChannels(member);
                    
                    if (reason == "join") {
                        this.triggerJoin(member.id, chans, {reason: reason, status: newUser.presence.status});
                    }
                    if (reason == "part") {
                        if (member) this.triggerPart(member.id, chans, {reason: reason, status: oldUser.presence.status});
                    }
                });
                
                
                this.log("Environment is now ready!");
                
                this.emit('connected', this);
            });
    }
    
    
    disconnect() {
        this._localClient.detachFromClient(this)
            .then(() => {
                this._client = null;
                this._server = null;
                this.log(`Disconnected from ${this._name}`);
                this.emit('disconnected', this);
            });
    }
    
    
    msg(targetid, msg) {
        var targetchan = this.getActualChanFromTarget(targetid);

        if (!targetchan) {
            targetchan = this._channels[this.param('defaultchannel')];
        }

        this._localClient.outbox(targetchan, msg);
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
        
        if (targetchan.type == "dm" || !targetchan.type) return [targetchan.recipient.id];
        
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
    
    channelIdToType(channelid) {
        var chan = this.getActualChanFromTarget(channelid);
        if (!chan) return "unknown";
        if (!chan.type || chan.type == "dm") return "private";
        return "regular";
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
    
    get client() { return this._localClient; }
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
            let pfm = channel.permissionsFor(member);
            if (!pfm || !pfm.hasPermission) continue;
            if (pfm.hasPermission("READ_MESSAGES")) {
                channels.push(channel);
            }
        }
        
        return channels;
    }
    
    
    triggerJoin(authorid, channels, info) {
        if (!info) info = {};
        for (let channel of channels) {
            this.emit('join', this, authorid, channel.id, info);
        }
    }
    
    triggerPart(authorid, channels, info) {
        if (!info) info = {};
        for (let channel of channels) {
            this.emit('part', this, authorid, channel.id, info);
        }
    }
    
    
};


module.exports = EnvDiscord;
