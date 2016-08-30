/* Module: Bridge -- This module was designed to bridge a multi-channel Discord server with a single IRC channel. */
/* Required environments: Discord, IRC */

var jsonfile = require('jsonfile');
var cd = require('color-difference');

//== Module settings (bridge.mod.json)

//*Name of an IRC channel the bot will join (including prefix)
var ircchannel = null;

//*Name of a Discord channel the bot will treat as default
var defaultdiscordchannel = null;

//==

var environments = null;
var modules = null;


var modname = "Bridge";
exports.name = modname;


exports.requiredenvironments = ["Discord", "IRC"];
exports.requiredmodules = [];


exports.initialize = function(envs, mods, moduleRequest) {

    //Load parameters

    var params;
    try {
        params = jsonfile.readFileSync("bridge.mod.json");
    } catch(e) {}
    
    if (params.ircchannel) ircchannel = params.ircchannel;
    if (!ircchannel) return false;
    
    if (params.defaultdiscordchannel) defaultdiscordchannel = params.defaultdiscordchannel;
    if (!defaultdiscordchannel) return false;
    
    if (!envs) return false;
    environments = envs;
    modules = mods;
    
    
    //Register callbacks
    
    envs.IRC.registerOnMessage(onIrcMessage);
    envs.Discord.registerOnMessage(onDiscordMessage);
    
    return true;
}


// # Module code below this line #


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


//Event handlers


function onIrcMessage(env, type, message, authorid, rawobject) {

    var target = null;

    var directedmessage = /^\[#([a-zA-Z0-9]+)\] (.+)/.exec(message);
    if (directedmessage) {
        target = directedmessage[1];
        message = directedmessage[2];
    }

    var bold = null;
    var und = null;
    var ita = null;
    var finalmsg = message.replace(/([0-9]{1,2}(,[0-9]{1,2})?)?/g, "").replace(//g, "") + "";
    for (var i = 0; i < finalmsg.length; i++) {
        if (finalmsg[i] == "") {
            if (und === null) und = i;
            else {
                finalmsg = finalmsg.slice(0, und) + "__" + finalmsg.slice(und + 1, i) + "__" + finalmsg.slice(i + 1);
                und = null;
                i += 2;
            }
        } else if (finalmsg[i] == "") {
            if (bold === null) bold = i;
            else {
                finalmsg = finalmsg.slice(0, bold) + "**" + finalmsg.slice(bold + 1, i) + "**" + finalmsg.slice(i + 1);
                bold = null;
                i += 2;
            }
        } else if (finalmsg[i] == "") {
            if (ita === null) ita = i;
            else {
                finalmsg = finalmsg.slice(0, ita) + "*" + finalmsg.slice(ita + 1, i) + "*" + finalmsg.slice(i + 1);
                ita = null;
            }
        } else if (finalmsg[i] == "") {
            var off = 0;
            if (ita !== null) {
                finalmsg = finalmsg.slice(0, ita) + "*" + finalmsg.slice(ita + 1, i + off) + "*" + finalmsg.slice(i + off - 1);
                off += 1;
            }
            if (bold !== null) {
                finalmsg = finalmsg.slice(0, bold) + "**" + finalmsg.slice(bold + 1, i + off) + "**" + finalmsg.slice(i + off - 1);
                off += 3;
                if (und !== null && und > bold) und += 1;
            }
            if (und !== null) {
                finalmsg = finalmsg.slice(0, und) + "__" + finalmsg.slice(und + 1, i + off) + "__" + finalmsg.slice(i + off - 1);
                off += 3;
            }
            bold = null;
            und = null;
            ita = null;
        }
    }
    
    finalmsg = finalmsg.replace(/@(([^ #]+)(#[0-9]{4})?)/, function(match, userornick) {
        var refid = environments.Discord.displayNameToId(userornick);
        if (refid) return "<@" + refid + ">";
        return match;
    });
    
    finalmsg = finalmsg.replace(/^([^:]+): /, function(match, userornick) {
        var refid = environments.Discord.displayNameToId(userornick);
        if (refid) return "<@" + refid + ">";
        return match;
    });
    
    if (type == "action") {
        environments.Discord.msg(target, "_* `" + environments.IRC.idToDisplayName(authorid) + "` " + finalmsg + "_");
    } else if (type == "regular") {
        environments.Discord.msg(target, "`<" + environments.IRC.idToDisplayName(authorid) + ">` " + finalmsg);
    }
}


function onDiscordMessage(env, type, message, authorid, rawobject) {
    
    var server = environments.Discord.getRawObject().server;
    var finalmsg = message;
    
    var authorname = environments.Discord.idToDisplayName(authorid);
    
    var roles = server.roles;
    for (var i = 0; i < roles.length; i++) {
        if (rawobject.author.hasRole(roles[i])) {
            authorname = "" + closestTtyColor(roles[i].colorAsHex()) + authorname + "";
            break;
        }
    }
    
    finalmsg = finalmsg.replace(/<@!?([0-9]+)>/g, function(match, id) {
        var user = server.members.get("id", id);
        if (!user) return "";
        return "@" + (server.detailsOfUser(user).nick ? server.detailsOfUser(user).nick : user.username);
    });
    
    finalmsg = finalmsg.replace(/<#([0-9]+)>/g, function(match, id) {
        var chan = server.channels.get("id", id);
        if (!chan) return "";
        return "#" + chan.name;
    });
    
    finalmsg = authorname + ": " + finalmsg.replace(/__(.*?)__/g, "$1").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1").replace(/_(.*?)_/g, "$1");
    
    if (rawobject.channel.name != defaultdiscordchannel) {
        finalmsg = "[#" + rawobject.channel.name + "] " + finalmsg;
    }
    
    if (type == "regular") {
        environments.IRC.msg(ircchannel, finalmsg);
    }
    
};
