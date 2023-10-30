import { closest } from 'color-diff';
import diff from 'diff';
import { ChannelType } from 'discord.js';
import emoji  from 'emoji-toolkit';

import Behavior from '../src/Behavior.js';

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

//From StackOverflow
async function replaceAsync(str, regex, callback) {
    const promises = [];
    str.replace(regex, (match, ...args) => {
        promises.push(callback(match, ...args));
    });
    let data = await Promise.all(promises);
    return str.replace(regex, () => data.shift());
}

export default class BridgeDiscordIRC extends Behavior {

    get description() { return "Bridges a multi-channel Discord server with a single IRC channel"; }

    get params() { return [
        {n: 'defaultdiscordchannel', d: "ID of a Discord channel to receive IRC messages by default"},
        {n: 'ircchannel', d: "ID/name of the IRC channel the bot will join (including prefix)"},
        {n: 'discordBlacklist', d: "Discord channels NOT to bridge [ID, ...]"},
        {n: 'discordOneWay', d: "Discord channels that will broadcast to IRC, but IRC can't send to them [ID, ...]"}
    ]; }
    
    get defaults() { return {
        discordBlacklist: [],
        discordOneWay: []
    }; }
    
    get requiredEnvironments() { return {
        Discord: 'Discord',
        IRC: 'IRC'
    }; }
    
    get requiredBehaviors() { return {
        Users: "Users"
    }; }

    get isMultiInstanceable() { return true; }

    constructor(name) {
        super('BridgeDiscordIRC', name);

        this._convertedColorMap = [];
        for (let color of colormap) {
            this._convertedColorMap.push(this.hexToObjectRGB(color || {R: 0, G: 0, B: 0}));
        }
    }

    get discord() {
        return this.env("Discord");
    }
    
    get irc() {
        return this.env("IRC");
    }    


    initialize(opt) {
        if (!super.initialize(opt)) return false;    
        
        //Register callbacks
        
        this.irc.on('message', this.onIrcMessage, this);
        this.discord.on('message', this.onDiscordMessage, this);
        
        this.discord.on('connected', (env) => {
            env.client.on('messageUpdate', (oldMessage, newMessage) => {
                if (oldMessage.channel.type == ChannelType.DM) return;
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


    async onIrcMessage(env, type, message, authorid, channelid, rawobject) {
        if (type != "action" && type != "regular") return;

        let target = this.param('defaultdiscordchannel') || null;

        let directedmessage = /^\[#([a-zA-Z0-9]+)\] (.+)/.exec(message);
        if (directedmessage) {
            target = directedmessage[1];
            message = directedmessage[2];
            
            let targetchan = await this.discord.server.channels.cache.find(c => c.name == target);
            if (targetchan && (
                this.param('discordBlacklist').indexOf(targetchan.id) > -1
                || this.param('discordOneWay').indexOf(targetchan.id) > -1)) return;
        }

        let finalmsg = this.discord.applyFormatting(this.irc.normalizeFormatting(message));

        let resolveMentions = async (match, userornick) => {
            let refid = await this.irc.displayNameToId(userornick);
            let discordid = await this.translateAccountMentions(this.irc, refid, this.discord, target);
            if (discordid) return "<@" + discordid + ">";
            refid = await this.discord.displayNameToId(userornick);
            if (refid) return "<@" + refid + ">";
            return match;
        }
        
        finalmsg = await replaceAsync(finalmsg, /@(([^ #]+)(#[0-9]{4})?)/, resolveMentions);
        finalmsg = await replaceAsync(finalmsg, /^([^:]+):/, resolveMentions);
        
        finalmsg = emoji.shortnameToUnicode(finalmsg);
        
        if (type == "action") {
            this.discord.msg(target, "_* `" + env.idToDisplayName(authorid) + "` " + finalmsg + "_");
        } else if (type == "regular") {
            this.discord.msg(target, "`<" + env.idToDisplayName(authorid) + ">` " + finalmsg);
        }
    }


    async onDiscordMessage(env, type, message, authorid, channelid, rawobject) {
        if (type != "regular") return;
        if (this.param('discordBlacklist').indexOf(channelid) > -1) return;
        
        let finalmsg = message;

        let action = false;
        
        let authorname = env.idToDisplayName(authorid);
        
        let roles = [...env.server.roles.cache.values()].sort((a, b) => (b.position - a.position));
        for (let role of roles) {
            if (rawobject.member.roles.cache.get(role.id)) {
                authorname = "" + this.closestTtyColor(role.hexColor) + authorname + "";
                break;
            }
        }
        
        finalmsg = await replaceAsync(finalmsg, /<@!?([0-9]+)>/g, async (match, id) => {
            let ircid = await this.translateAccountMentions(this.discord, id, this.irc, this.param('ircchannel'));
            if (ircid) {
                let dn = await this.irc.idToDisplayName(ircid);
                return "@" + dn;
            }
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
    
    
    async onDiscordEdit(env, changes, authorid, channelid, oldMessage, newMessage) {
        
        let authorname = env.idToDisplayName(authorid);
        
        let roles = [...env.server.roles.cache.values()].sort((a, b) => (b.position - a.position));
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

        finalmsg = await replaceAsync(finalmsg, /<@!?([0-9]+)>/g, async (match, id) => {
            let ircid = await this.translateAccountMentions(this.discord, id, this.irc, this.param('ircchannel'));
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
    
    
    async translateAccountMentions(fromenv, fromid, toenv, tochan) { 
        if (!fromenv || !fromid || !toenv) return null;

        let handles = await this.be("Users").getHandlesById(fromenv.name, fromid);
        if (!handles.length) return null;

        let toids = await toenv.listUserIds(tochan);
        if (!toids.length) return null;

        for (let handle of handles) {  //Accounts of users in the channel where the message was written
            for (let possibleid of await this.be("Users").getIds(handle, toenv.name)) {  //ID patterns of those accounts
                for (let toid of toids) {  //Cross check against IDs of users in the channel where the message will be sent
                    if (RegExp(possibleid).exec(toid)) {
                        return toid;
                    }
                }
            }
        }
        
        return null;
    }

    hexToObjectRGB(hexrgb) {
        let ext = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hexrgb);
        if (!ext) return null;
        return {
            R: parseInt(ext[1], 16),
            G: parseInt(ext[2], 16),
            B:parseInt(ext[3], 16)
        };
    }

    sameObjectRGB(rgba, rgbb) {
        return rgba.R === rgbb.R && rgba.G === rgbb.G && rgba.B === rgbb.B;
    }

    closestTtyColor(hexrgb) {
        let pick = closest(this.hexToObjectRGB(hexrgb), this._convertedColorMap);
        let color = this._convertedColorMap.findIndex(color => this.sameObjectRGB(pick, color));
        color = color.toString();
        if (color.length < 2) color = "0" + color;
        return color;
    }
    
    
}
