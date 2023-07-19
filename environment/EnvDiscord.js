/* Environment: Discord -- This environment connects to a Discord server/guild. */

const moment = require('moment');

const Environment = require('../Environment.js');
const { verifyString, ChannelType } = require('discord.js');

const MAXIMUM_MSG_LENGTH = 2000;

class EnvDiscord extends Environment {

    get requiredParams() { return [
        'token',                //Discord application token
        'server',               //Server ID to operate on (application must have been previously added to server)
        'privatemessages'       //Environment will receive private messages to the bot
    ]; }
        
    get optionalParams() { return [
        'senddelay',            //Message queue send delay (ms)
        'webhooklifetime',      //How long to keep a webhook (s)
        'maxwebhooks'           //Maximum total simultaneous webhooks
    ]; }
    
    get sharedModules() { return [
        'DiscordClient'
    ]; }

    constructor(name) {
        super('Discord', name);

        this._params['senddelay'] = 500;
        this._params["webhooklifetime"] = 60;
        this._params["maxwebhooks"] = 5;
        
        this._localClient = null;  //DiscordClient (manages shared discord.js Client object)
        this._client = null;  //Actual discord.js Client object
        this._server = null;  //discord.js Guild object (formerly Server) for the server identified by this environment's 'server' ID.
        this._channels = {};

        this._webhooks = {};  //{CHANNELID: {USERID: {userid, webhook, ts, cleartimer}, ...}, ...}
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        this._localClient = opt.sharedInstances.DiscordClient;

        opt.pushCleanupHandler((next) => {
            let promises = [];
            for (let channelid in this._webhooks) {
                for (let userid in this._webhooks[channelid]) {
                    promises.push(this.removeWebhook(channelid, userid));
                }
            }
            Promise.all(promises).then(next);
        });

        return true;
    }
    
    
    connect() {

        let params = this.params;

        this.log(`Connecting to ${params.server}`);

        return this._localClient.prepareClient(this, this.param('token'), this.param('sendDelay'))
            .then(async (client) => {
                this._client = client;
                this._server = await client.guilds.fetch(params.server);
                
                if (!this._server) {
                    this.log('error', "Could not obtain server object.");
                }
                
                this._localClient.on("messageCreate", (message) => {
                    if (message.author.id == client.user.id) return;
                    
                    let type = "regular";
                    let channelid = message.channel.id;
                    
                    if (message.channel.type == ChannelType.DM) {
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
                    for (let role of member.roles.cache.values()) {
                        this.emit('gotRole', this, member.id, role.id);
                    }
                });
                
                
                this._localClient.on("guildMemberRemove", (member) => {
                    if (!member.user.presence || member.user.presence.status == "offline") return;
                    if (member.guild.id != this._server.id) return;
                    
                    let chans = this.findAccessChannels(member);
                    if (chans.length) {
                        this.triggerPart(member.id, chans, {reason: "remove"});
                    }
                    for (let role of member.roles.cache.values()) {
                        this.emit('lostRole', this, member.id, role.id);
                    }
                });
                
                
                this._localClient.on("guildMemberUpdate", (oldMember, newMember) => {
                    if (!newMember.user.presence || newMember.user.presence.status == "offline") return;
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
    
    
    msg(targetid, msg, options) {
        let targetchan = this.getActualChanFromTarget(targetid);
        if (!targetchan || !options && !msg) return false;
        if (!options) options = {};
        else options = {...options};

        if (msg) {
            if (typeof msg == "object") {
                if (msg.data !== undefined) options.embeds = [msg];
                else if (msg.size !== undefined || msg.attachment !== undefined) options.files = [msg];
                else for (let key in msg) {
                    options[key] = msg[key];
                }
            } else {
                if (msg.length > MAXIMUM_MSG_LENGTH) {
                    let code = msg.trim().match(/^```[a-z]?/i);
                    if (!msg.trim().match(/```$/)) code = undefined;
                    let partPromises = [];
                    for (let part of this.splitMessage(msg, {
                        maxLength: MAXIMUM_MSG_LENGTH,
                        prepend: code ? code[0] : undefined,
                        append: code ? '```' : undefined
                    })) {
                        if (part != msg) {
                            partPromises.push(this.msg(targetid, part, options));
                        }
                    }
                    return Promise.all(partPromises);
                } else {
                    options.content = msg;
                }
            }
        }

        return this._localClient.outbox(targetchan, options);
    }

    react(msg, emoji) {  //Discord-specific
        if (msg.client?.user?.id != this._client.user?.id) return false;
        return this._localClient.reactionbox(msg, emoji);
    }
    
    
    notice(targetid, msg, options) {
        this.msg(targetid, msg, options);
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
            let cache = this._server.members.cache.filter(member => member.user.username == displayname);
            if (cache.size == 1) {
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
        if (!targetchan) return [];
        
        if (targetchan.type == ChannelType.DM || !targetchan.type) return [targetchan.recipient.id];
        
        let ids = [];
        if (targetchan.type == ChannelType.GuildText || targetchan.type == ChannelType.GuildAnnouncement || targetchan.type == ChannelType.GuildForum) {
            for (let member of targetchan.members.values()) {
                ids.push(member.id);
            }
        }
        
        return ids;
    }
    
    
    listUserRoles(id, channel) {
        let member = this._server.members.cache.get(id);
        if (!member) return [];
        let result = [];
        let roles = [...member.roles.cache.values()].sort((a, b) => (b.position - a.position));
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
        if (!chan.type || chan.type == ChannelType.DM) return "private";
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
                this._channels[targetid] = this._server.channels.cache.filter(channel => channel.type == ChannelType.GuildText).get(targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.members.cache.get(targetid);
            }
            if (!this._channels[targetid]) {
                this._channels[targetid] = this._server.channels.cache.filter(channel => channel.type == ChannelType.GuildText).find(channel => channel.name == targetid);
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
        
        for (let channel of member.guild.channels.cache.values()) {
            let pfm = channel.permissionsFor(member);
            if (!pfm || !pfm.has) continue;
            if (pfm.has("ViewChannel")) {
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


    scanEveryMessage(channel, onMessage, onEnd) {
        if (!channel || !onMessage) return;
        let scanning = null;
        let scanner = () => {
            channel.messages.fetch({
                limit: 100,
                before: scanning
            }).then((messages) => {
                let endNow = false;
                let messagesarr = [...messages.values()];
                if (messagesarr.length < 100) endNow = true;
                for (let message of messagesarr) {
                    onMessage(message);
                }
                if (!endNow) {
                    scanning = messagesarr[messagesarr.length - 1].id;
                    setTimeout(scanner, 500);
                } else if (onEnd) {
                    onEnd(channel);
                }
            });
        };
        scanner();
    }


    extractRoleId(roleid) {
        if (!roleid) return null;
        if (roleid.match(/^[0-9]+$/)) return roleid;
        let extr = roleid.match(/<@&([0-9]+)>/);
        if (extr) return extr[1];
        return null;
    }

    extractChannelId(channelid) {
        if (!channelid) return null;
        if (channelid.match(/^[0-9]+$/)) return channelid;
        let extr = channelid.match(/<#([0-9]+)>/);
        if (extr) return extr[1];
        return null;
    }


    //Written by the djs contributors
    splitMessage(text, { maxLength = 2_000, char = '\n', prepend = '', append = '' } = {}) {
        text = verifyString(text);
        if (text.length <= maxLength) return [text];
        let splitText = [text];
        if (Array.isArray(char)) {
            while (char.length > 0 && splitText.some(elem => elem.length > maxLength)) {
                const currentChar = char.shift();
                if (currentChar instanceof RegExp) {
                    splitText = splitText.flatMap(chunk => chunk.match(currentChar));
                } else {
                    splitText = splitText.flatMap(chunk => chunk.split(currentChar));
                }
            }
        } else {
            splitText = text.split(char);
        }
        if (splitText.some(elem => elem.length > maxLength)) throw new RangeError('SPLIT_MAX_LEN');
        const messages = [];
        let msg = '';
        for (const chunk of splitText) {
            if (msg && (msg + char + chunk + append).length > maxLength) {
                messages.push(msg + append);
                msg = prepend;
            }
            msg += (msg && msg !== prepend ? char : '') + chunk;
        }
        return messages.concat(msg).filter(m => m);
    }


    //Temporary webhooks that simulate members

    async getWebhook(channel, member) {
        if (!member) throw {error: "Member must be provided."};
        if (!channel) throw {error: "Channel must be provided."};
        if (!this._webhooks[channel.id]?.[member.id]) return this.prepareWebhook(channel, member);
        this._webhooks[channel.id][member.id].ts = moment().unix();
        clearTimeout(this._webhooks[channel.id][member.id].cleartimer);
        this.setWebhookCleanupTimer(channel.id, member.id);
        return this._webhooks[channel.id][member.id].webhook;
    }

    countWebhooks() {
        return Object.values(this._webhooks).reduce((count, channelhooks) => count += Object.keys(channelhooks).length, 0);
    }

    oldestWebhook() {
        return Object.values(this._webhooks).reduce((candidate, channelhooks) => {
            let oldestinchannel = channelhooks.sort((a, b) => b.ts - a.ts)[0];
            if (!candidate || oldestinchannel.ts < candidate.ts) return oldestinchannel;
            return candidate;
        });
    }

    async prepareWebhook(channel, member) {
        if (!member) throw {error: "Member must be provided."};
        if (!channel) throw {error: "Channel must be provided."};
        
        if (this.countWebhooks() >= this.param("maxwebhooks")) {
            let oldest = this.oldestWebhook();
            await this.removeWebhook(oldest.channelid, oldest.userid);
        }

        let webhook = await channel.createWebhook({name: member.displayName, avatar: member.user.displayAvatarURL(), reason: "User simulation."});
        if (!this._webhooks[channel.id]) this._webhooks[channel.id] = {};
        this._webhooks[channel.id][member.id] = {channelid: channel.id, userid: member.id, webhook: webhook, ts: moment().unix(), cleartimer: null};
        this.setWebhookCleanupTimer(channel.id, member.id);
        return webhook;
    }

    async removeWebhook(channelid, userid) {
        if (!channelid || !userid || !this._webhooks[channelid]?.[userid]) return null;
        clearTimeout(this._webhooks[channelid][userid].cleartimer);
        let webhook = this._webhooks[channelid][userid].webhook;
        delete this._webhooks[channelid][userid];
        return webhook.delete();
    }

    setWebhookCleanupTimer(channelid, userid) {
        if (!userid || !this._webhooks[channelid]?.[userid]) return;
        this._webhooks[channelid][userid].cleartimer = setTimeout(function() {
            this.removeWebhook(channelid, userid);
        }.bind(this), this.param("webhooklifetime") * 1000);
    }
    
    
};


module.exports = EnvDiscord;
