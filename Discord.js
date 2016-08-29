var Discord = require("discord.js");
var jsonfile = require('jsonfile');
var cd = require('color-difference');

var PA = null;
exports.setMain = function (mains) { PA = mains; }
exports.onReassemble = function () {}

var mybot = new Discord.Client();

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

// callbacks

var server;
var channel;
var channels = {};

exports.messageCallback = function(from, to, message, messageObj) {
    var targetchan = channel;

    var directedmessage = /^\[#([a-zA-Z0-9]+)\] (.+)/.exec(message);
    if (directedmessage) {
        if (!channels[directedmessage[1]]) {
            channels[directedmessage[1]] = server.channels.getAll("type", "text").get("name", directedmessage[1]);
        }
        if (channels[directedmessage[1]]) {
            targetchan = channels[directedmessage[1]];
        }
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
    
    finalmsg = finalmsg.replace(/@([^ #]+)(#([0-9]{4}))?/, function(match, userornick, z, discrim) {
        var refuser = null;
        if (discrim) {
            refuser = server.members.getAll("username", userornick).get("discriminator", discrim);
        } else {
            var cache = server.members.getAll("username", userornick);
            if (cache.length == 1) {
                refuser = cache[0];
            } else {
                userornick = userornick.toLowerCase();
                for (var i = 0; i < server.members.length; i++) {
                    var nick = server.detailsOfUser(server.members[i]).nick;
                    if (nick && nick.toLowerCase() == userornick) {
                        refuser = server.members[i];
                        break;
                    }
                }
            }
        }
        if (refuser) {
            return "<@" + refuser.id + ">";
        }
        return match;
    });
    
    finalmsg = finalmsg.replace(/^([^:]+): /, function(match, userornick) {
        var refuser = null;
        var parts = userornick.split("#");
        if (parts[1]) {
            refuser = server.members.getAll("username", parts[0]).get("discriminator", parts[1]);
        } else {
            var cache = server.members.getAll("username", userornick);
            if (cache.length == 1) {
                refuser = cache[0];
            } else {
                userornick = userornick.toLowerCase();
                for (var i = 0; i < server.members.length; i++) {
                    var nick = server.detailsOfUser(server.members[i]).nick;
                    if (nick && nick.toLowerCase() == userornick) {
                        refuser = server.members[i];
                        break;
                    }
                }
            }
        }
        if (refuser) {
            return "<@" + refuser.id + "> ";
        }
        return match;
    });
    
    mybot.sendMessage(targetchan, "`<" + from + ">` " + finalmsg);
}



// Discord related

var settings = jsonfile.readFileSync("discord.env");

mybot.on("message", function(message) {
    if (mybot.user.username == message.author.username) return;
    var finalmsg = message.content;
    
    var authorname = server.detailsOfUser(message.author).nick;
    if (!authorname) authorname = message.author.username;
    
    var roles = server.roles;
    for (var i = 0; i < roles.length; i++) {
        if (message.author.hasRole(roles[i])) {
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
    
    if (message.channel.name != channel.name) {
        finalmsg = "[#" + message.channel.name + "] " + finalmsg;
    }
    
    PA.client.say(settings.ircChannel, finalmsg);
});

mybot.on("ready", function(message) {
	server = mybot.servers.get("name", settings.discordServer);
	channel = server.channels.getAll("type", "text").get("name", settings.discordChannel);
	channels[settings.discordChannel] = channel;
	channels[server.defaultChannel.name] = server.defaultChannel;
});

mybot.loginWithToken(settings.token, function(err) {});
