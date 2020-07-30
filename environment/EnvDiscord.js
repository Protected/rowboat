/* Environment: Discord -- This environment connects to a Discord server/guild. */

const Environment = require('../Environment.js');


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

        let params = this.params;

        this.log(`Connecting to ${params.servername}`);

        return this._localClient.prepareClient(this, this.param('token'), this.param('sendDelay'))
            .then((client) => {
                this._client = client;
                this._server = client.guilds.cache.find(s => s.name == params.servername);
                
                if (!this._server) {
                    this.log('error', "Could not obtain server object.");
                }
                
                this._channels[params.defaultchannel] = this._server.channels.cache.filter(channel => channel.type == "text").find(channel => channel.name == params.defaultchannel);
                
                this._localClient.on("message", (message) => {
                    if (message.author.username == client.user.username) return;
                    
                    let type = "regular";
                    let channelid = message.channel.id;
                    
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
                    let chans = this.findAccessChannels(member);
                    if (chans.length) {
                        this.triggerJoin(member.id, chans, {reason: "add"});
                    }
                    let roles = member.roles.cache.array();
                    for (let role of roles) {
                        this.emit('gotRole', this, member.id, role.id);
                    }
                });
                
                
                this._localClient.on("guildMemberRemove", (member) => {
                    if (member.user.presence.status == "offline") return;
                    if (member.guild.id != this._server.id) return;
                    
                    let chans = this.findAccessChannels(member);
                    if (chans.length) {
                        this.triggerPart(member.id, chans, {reason: "remove"});
                    }
                    let roles = member.roles.cache.array();
                    for (let role of roles) {
                        this.emit('lostRole', this, member.id, role.id);
                    }
                });
                
                
                this._localClient.on("guildMemberUpdate", (oldMember, newMember) => {
                    if (newMember.user.presence.status == "offline") return;
                    if (newMember.guild.id != this._server.id) return;
                
                    //Channels
                
                    let had = {};
                    for (let chan of this.findAccessChannels(oldMember)) {
                        had[chan.id] = chan;
                    }
                    
                    let tojoin = [];
                    let topart = [];
                    
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
                    for (let role of oldMember.roles.cache) {
                        had[role.id] = role;
                    }
                    
                    let toget = [];
                    let tolose = [];
                    
                    for (let role of newMember.roles.cache) {
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
                
                
                this._localClient.on("presenceUpdate", (oldPresence, newPresence) => {
                    let reason = null;

                    if (!oldPresence) return;

                    if (oldPresence.status == "offline" && newPresence.status != "offline") {
                        reason = "join";
                    }
                    if (oldPresence.status != "offline" && newPresence.status == "offline") {
                        reason = "part";
                    }
                    if (!reason) return;
                    
                    let member = this._server.members.cache.get(newPresence.userID);
                    if (!member) return;
                    let chans = this.findAccessChannels(member);
                    
                    if (reason == "join") {
                        this.triggerJoin(member.id, chans, {reason: reason, status: newPresence.status});
                    }
                    if (reason == "part") {
                        if (member) this.triggerPart(member.id, chans, {reason: reason, status: oldPresence.status});
                    }
                });
                
                
                this.log("Environment is now ready!");
                
                this._hasConnected = true;
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
        let targetchan = this.getActualChanFromTarget(targetid);

        if (!targetchan) {
            targetchan = this._channels[this.param('defaultchannel')];
        }

        this._localClient.outbox(targetchan, msg);
    }
    
    
    notice(targetid, msg) {
        this.msg(targetid, msg);
    }
    

    idToDisplayName(id) {
        let member = this._server.members.cache.get(id);
        if (member) return (member.nickname ? member.nickname : member.user.username);
        let user = this._client.users.cache.get(id);
        if (user) return user.username;
        return id;
    }
    
    
    displayNameToId(displayname) {
        let refuser = null;

        let parts = displayname.split("#");
        
        if (parts[1]) {
            refuser = this._server.members.cache.filter(member => member.user.username == parts[0]).find(member => member.user.discriminator == parts[1]);
        } else {
            let cache = this._server.members.cache.filter(member => member.user.username == displayname).array();
            if (cache.length == 1) {
                refuser = cache[0];
            } else {
                displayname = displayname.toLowerCase();
                refuser = this._server.members.cache.find(member => member.nickname && member.nickname.toLowerCase() == displayname);
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
        return !!this._server.members.cache.get(id);
    }
    
    idIsAuthenticated(id) {
        return !!this._server.members.cache.get(id);
    }
    
    
    listUserIds(channel) {
        let targetchan = this.getActualChanFromTarget(channel);
        if (!targetchan) {
            targetchan = this._channels[this.param('defaultchannel')];
        }
        
        if (targetchan.type == "dm" || !targetchan.type) return [targetchan.recipient.id];
        
        let ids = [];
        if (targetchan.type == "text") {
            for (let member of targetchan.members.array()) {
                ids.push(member.id);
            }
        }
        
        return ids;
    }
    
    
    listUserRoles(id, channel) {
        let member = this._server.members.cache.get(id);
        if (!member) return [];
        let result = [];
        let roles = member.roles.cache.array().sort((a, b) => (b.position - a.position));
        for (let role of roles) {
            result.push(role.id);
        }
        return result;
    }
    
    
    channelIdToDisplayName(channelid) {
        let channel = this._server.channels.cache.get(channelid);
        if (channel) return channel.name;
        return channelid;
    }
    
    channelIdToType(channelid) {
        let chan = this.getActualChanFromTarget(channelid);
        if (!chan) return "unknown";
        if (!chan.type || chan.type == "dm") return "private";
        return "regular";
    }
    
    
    roleIdToDisplayName(roleid) {
        let role = this._server.roles.cache.get(roleid);
        if (role) return role.name;
        return roleid;
    }
    
    
    displayNameToRoleId(displayName) {
        if (!displayName) return null;
        let role = this._server.roles.cache.find(r => r.name.toLowerCase() == displayName.toLowerCase());
        if (role) return role.id;
        return null;
    }
    
    
    normalizeFormatting(text) {
        text = String(text).replace(/<@&([0-9]+)>/g, (match, id) => {
            let role = this._server.roles.cache.get(id);
            if (!role) return "";
            return "@" + role.name;
        });
        
        text = text.replace(/<@!?([0-9]+)>/g, (match, id) => {
            let user = this._server.members.cache.get(id);
            if (!user) return "";
            return "@" + (user.nickname ? user.nickname : user.user.username);
        });
        
        text = text.replace(/<#([0-9]+)>/g, (match, id) => {
            let chan = this._server.channels.cache.get(id);
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
        let targetchan = null;

        if (typeof targetid == "string") {
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.channels.cache.filter(channel => channel.type == "text").get(targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.members.cache.get(targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.channels.cache.filter(channel => channel.type == "text").find(channel => channel.name == targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.members.cache.find(channel => channel.name == targetid);
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
        let channels = [];
        if (!member) return channels;
        
        let allchannels = member.guild.channels.cache.array();
        for (let channel of allchannels) {
            let pfm = channel.permissionsFor(member);
            if (!pfm || !pfm.has) continue;
            if (pfm.has("VIEW_CHANNEL")) {
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
