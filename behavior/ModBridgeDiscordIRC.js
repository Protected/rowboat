/* Module: BridgeDiscordIRC -- This module was designed to bridge a multi-channel Discord server with a single IRC channel. */

const Module = require('../Module.js');
const cd = require('color-difference');
const diff = require('diff');

var emoji = require('emojione');
emoji.ascii = true;
delete emoji.asciiList['d:'];

const colormap = [
    "#FFFFFF",
    "#000000",
    "#00007F",
    "#009300",
    "#FF0000",
    "#7F0000",
    "#9C009C",
    "#FC7F00",
    "#FFFF00",
    "#00FC00",
    "#009393",
    "#00FFFF",
    "#0000FC",
    "#FF00FF",
    "#7F7F7F",
    "#D2D2D2"
];


class ModBridgeDiscordIRC extends Module {


    get isMultiInstanceable() { return true; }

    get requiredParams() { return [
        'envdiscord',           //Name of the Discord environment
        'defaultdiscordchannel',    //ID of a Discord channel the bot will treat as default
        'envirc',               //Name of the IRC environment
        'ircchannel'            //ID/name of an IRC channel the bot will join (including prefix)
    ]; }
    
    get optionalParams() { return [
        'discordBlacklist',     //Discord channels NOT to bridge (list of IDs)
        'discordOneWay'         //Discord channels that will broadcast to IRC, but IRC can't send to them
    ]; }
    
    get requiredEnvironments() { return [
        'Discord',
        'IRC'
    ]; }
    
    get requiredModules() { return [
        'Users'
    ]; }

    constructor(name) {
        super('BridgeDiscordIRC', name);
        
        this._params['discordBlacklist'] = [];
        this._params['discordOneWay'] = [];
    }


    get irc() {
        return this.env(this.param('envirc'));
    }
    
    get discord() {
        return this.env(this.param('envdiscord'));
    }
    

    initialize(opt) {
        if (!super.initialize(opt)) return false;
        
        
        //Register callbacks
        
        this.irc.on('message', this.onIrcMessage, this);
        this.discord.on('message', this.onDiscordMessage, this);
        
        this.discord.on('connected', (env) => {
            env.client.on('messageUpdate', (oldMessage, newMessage) => {
                if (oldMessage.channel.type == "dm") return;
                if (oldMessage.channel.guild.id != env.server.id) return;
                if (this.param('discordBlacklist').indexOf(oldMessage.channel.id) > -1) return;
                if (oldMessage.content == newMessage.content) return;
                
                let changes = diff.diffChars(oldMessage.content, newMessage.content);
                this.onDiscordEdit(env, changes, oldMessage.author.id, oldMessage.channel.id, oldMessage, newMessage);
            });
        }, this);
        
        return true;
    }


    // # Module code below this line #


    //Event handlers


    onIrcMessage(env, type, message, authorid, channelid, rawobject) {
        if (type != "action" && type != "regular") return;

        let target = null;

        let directedmessage = /^\[#([a-zA-Z0-9]+)\] (.+)/.exec(message);
        if (directedmessage) {
            target = directedmessage[1];
            message = directedmessage[2];
            
            let targetchan = this.discord.server.channels.cache.find(c => c.name == target);
            if (targetchan && (
                this.param('discordBlacklist').indexOf(targetchan.id) > -1
                || this.param('discordOneWay').indexOf(targetchan.id) > -1)) return;
        }

        let finalmsg = this.discord.applyFormatting(this.irc.normalizeFormatting(message));
        
        let resolveMentions = (match, userornick) => {
            let refid = this.irc.displayNameToId(userornick);
            let discordid = this.translateAccountMentions(this.irc, refid, this.discord, target);
            if (discordid) return "<@" + discordid + ">";
            refid = this.discord.displayNameToId(userornick);
            if (refid) return "<@" + refid + ">";
            return match;
        }
        
        finalmsg = finalmsg.replace(/@(([^ #]+)(#[0-9]{4})?)/, resolveMentions);
        finalmsg = finalmsg.replace(/^([^:]+):/, resolveMentions);
        
        finalmsg = emoji.shortnameToUnicode(finalmsg);
        
        if (type == "action") {
            this.discord.msg(target, "_* `" + env.idToDisplayName(authorid) + "` " + finalmsg + "_");
        } else if (type == "regular") {
            this.discord.msg(target, "`<" + env.idToDisplayName(authorid) + ">` " + finalmsg);
        }
    }


    onDiscordMessage(env, type, message, authorid, channelid, rawobject) {
        if (type != "regular") return;
        if (this.param('discordBlacklist').indexOf(channelid) > -1) return;
        
        let finalmsg = message;
        
        let action = false;
        
        let authorname = env.idToDisplayName(authorid);
        
        let roles = env.server.roles.cache.array().sort((a, b) => (b.position - a.position));
        for (let role of roles) {
            if (rawobject.member.roles.cache.get(role.id)) {
                authorname = "" + this.closestTtyColor(role.hexColor) + authorname + "";
                break;
            }
        }
        
        finalmsg = finalmsg.replace(/<@!?([0-9]+)>/g, (match, id) => {
            let ircid = this.translateAccountMentions(this.discord, id, this.irc, this.param('ircchannel'));
            if (ircid) return "@" + this.irc.idToDisplayName(ircid);
            return match;
        });
        
        finalmsg = this.irc.applyFormatting(this.discord.normalizeFormatting(finalmsg));
        finalmsg = emoji.shortnameToAscii(emoji.toShort(finalmsg));
        
        action = !!/^_[^_](.*[^_])?_$/.exec(finalmsg);
        
        let lines = finalmsg.split("\n");
        
        for (let line of lines) {
            if (action) {
                line = '* ' + authorname + " " + line;
            } else {
                line = '(' + authorname + ") " + line;
            }
            
            if (rawobject.channel.id != this.param('defaultdiscordchannel')) {
                line = "[#" + rawobject.channel.name + "] " + line;
            }
            
            if (type == "regular") {
                this.irc.msg(this.param('ircchannel'), line);
            }
        }
        
    }
    
    
    onDiscordEdit(env, changes, authorid, channelid, oldMessage, newMessage) {
        
        let authorname = env.idToDisplayName(authorid);
        
        let roles = env.server.roles.cache.array().sort((a, b) => (b.position - a.position));
        for (let role of roles) {
            if (oldMessage.member.roles.cache.get(role.id)) {
                authorname = "" + this.closestTtyColor(role.hexColor) + authorname + "";
                break;
            }
        }
        
        let finalmsg = '';
        for (let change of changes) {
            if (change.added) {
                finalmsg += "03" + change.value + "";
            } else if (change.removed) {
                finalmsg += "15" + change.value + "";
            } else {
                finalmsg += change.value;
            }
        }

        finalmsg = finalmsg.replace(/<@!?([0-9]+)>/g, (match, id) => {
            let ircid = this.translateAccountMentions(this.discord, id, this.irc, this.param('ircchannel'));
            if (ircid) return "@" + this.irc.idToDisplayName(ircid);
            return match;
        });
        
        finalmsg = this.irc.applyFormatting(this.discord.normalizeFormatting(finalmsg));
        finalmsg = emoji.shortnameToAscii(emoji.toShort(finalmsg));
        
        let lines = finalmsg.split("\n");
        
        for (let line of lines) {
            line = 'Edit by ' + authorname + ": " + line;
            
            if (oldMessage.channel.id != this.param('defaultdiscordchannel')) {
                line = "[#" + oldMessage.channel.name + "] " + line;
            }
            
            this.irc.msg(this.param('ircchannel'), line);
        }
    }
    
    
    //Auxiliary
    
    
    translateAccountMentions(fromenv, fromid, toenv, tochan) { 
        if (!fromenv || !fromid || !toenv) return null;

        let handles = this.mod("Users").getHandlesById(fromenv.name, fromid);
        if (!handles.length) return null;

        let toids = toenv.listUserIds(tochan);
        if (!toids.length) return null;

        for (let handle of handles) {  //Accounts of users in the channel where the message was written
            for (let possibleid of this.mod("Users").getIds(handle, toenv.name)) {  //ID patterns of those accounts
                for (let toid of toids) {  //Cross check against IDs of users in the channel where the message will be sent
                    if (RegExp(possibleid).exec(toid)) {
                        return toid;
                    }
                }
            }
        }
        
        return null;
    }

    closestTtyColor(hexrgb) {
        let distance = 101;
        let color = 0;
        for (let i = 0; i < colormap.length; i++) {
            let r = cd.compare(hexrgb, colormap[i]);
            if (r < distance) {
                distance = r;
                color = i;
            }
        }
        color = color.toString();
        if (color.length < 2) color = "0" + color;
        return color;
    }
    
    
}


module.exports = ModBridgeDiscordIRC;
