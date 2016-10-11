/* Module: BridgeDiscordIRC -- This module was designed to bridge a multi-channel Discord server with a single IRC channel. */

var Module = require('./Module.js');
var cd = require('color-difference');
var emoji = require('emojione');

emoji.ascii = true;
delete emoji.asciiList['d:'];


class ModBridgeDiscordIRC extends Module {


    get isMultiInstanceable() { return true; }

    get requiredParams() { return [
        'envdiscord',           //Name of the Discord environment
        'defaultdiscordchannel',    //ID of a Discord channel the bot will treat as default
        'envirc',               //Name of the IRC environment
        'ircchannel'            //ID/name of an IRC channel the bot will join (including prefix)
    ]; }
    
    get optionalParams() { return [
        'discordBlacklist'      //Discord channels NOT to bridge (list of IDs)
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
    }


    get irc() {
        return this.env(this.param('envirc'));
    }
    
    get discord() {
        return this.env(this.param('envdiscord'));
    }
    

    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;
        
        
        //Register callbacks
        
        this.irc.registerOnMessage(this.onIrcMessage, this);
        this.discord.registerOnMessage(this.onDiscordMessage, this);
        
        return true;
    }


    // # Module code below this line #


    //Event handlers


    onIrcMessage(env, type, message, authorid, channelid, rawobject) {
        if (type != "action" && type != "regular") return;

        var target = null;

        var directedmessage = /^\[#([a-zA-Z0-9]+)\] (.+)/.exec(message);
        if (directedmessage) {
            target = directedmessage[1];
            message = directedmessage[2];
            
            let targetchan = this.discord.server.channels.find('name', target);
            if (targetchan && this.param('discordBlacklist').indexOf(targetchan.id) > -1) return;
        }

        var finalmsg = this.discord.applyFormatting(this.irc.normalizeFormatting(message));
        
        var resolveMentions = (match, userornick) => {
            var refid = this.irc.displayNameToId(userornick);
            var discordid = this.translateAccountMentions(this.irc, refid, this.discord, target);
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
        
        var server = env.server;
        var finalmsg = message;
        
        var action = false;
        
        var authorname = env.idToDisplayName(authorid);
        
        var roles = server.roles.array().sort((a, b) => (b.position - a.position));
        for (let role of roles) {
            if (rawobject.member.roles.find('id', role.id)) {
                authorname = "" + closestTtyColor(role.hexColor) + authorname + "";
                break;
            }
        }
        
        finalmsg = finalmsg.replace(/<@!?([0-9]+)>/g, (match, id) => {
            var ircid = this.translateAccountMentions(this.discord, id, this.irc, this.param('ircchannel'));
            if (ircid) return "@" + this.irc.idToDisplayName(ircid);
            return match;
        });
        
        finalmsg = this.irc.applyFormatting(this.discord.normalizeFormatting(finalmsg));
        finalmsg = emoji.shortnameToAscii(emoji.toShort(finalmsg));
        
        action = !!/^_[^_](.*[^_])?_$/.exec(finalmsg);
        
        var lines = finalmsg.split("\n");
        
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
    
    
    //Auxiliary
    
    
    translateAccountMentions(fromenv, fromid, toenv, tochan) { 
        if (!fromenv || !fromid || !toenv) return null;

        var handles = this.mod("Users").getHandlesById(fromenv.name, fromid);
        if (!handles.length) return null;

        var toids = toenv.listUserIds(tochan);
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
    
    
}


module.exports = ModBridgeDiscordIRC;


//Auxiliary

var colormap = [
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

function closestTtyColor(hexrgb) {
    var distance = 101;
    var color = 0;
    for (var i = 0; i < colormap.length; i++) {
        var r = cd.compare(hexrgb, colormap[i]);
        if (r < distance) {
            distance = r;
            color = i;
        }
    }
    color = color.toString();
    if (color.length < 2) color = "0" + color;
    return color;
}
