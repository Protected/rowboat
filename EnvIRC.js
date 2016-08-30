/* Environment: IRC -- This environment connects to an IRC server. */

var jsonfile = require('jsonfile');
var irc = require('irc');

//== Environment settings (irc.env.json)

//*IP address or hostname of the IRC server
var serverhost = null;

//Port of the IRC server
var port = 6667;

//Use SSL connection
var ssl = false;

//*Nickname for the connection
var nickname = null;

//*List of channels to join (each item is a string representing a channel name)
var channels = null;

//Nickserv's nickname
var nickservnick = 'Nickserv';

//Nickserv password
var nickpass = null;

//Username
var ident = 'myshelter';

//Real name
var realname = 'Not a pun, just a misunderstanding.';

//==

var client = null;
var prefixes = [];
var people = {};

var cbError = [];
var cbMessage = [];


var envname = "IRC";
exports.name = envname;


exports.initialize = function() {
    var params;
    try {
        params = jsonfile.readFileSync("irc.env.json");
    } catch (e) {}
    
    if (params.serverhost) serverhost = params.serverhost;
    if (!serverhost) return false;
    
    if (params.port) port = params.port;
    if (params.ssl) ssl = params.ssl;
    
    if (params.nickname) nickname = params.nickname;
    if (!nickname) return false;
    
    if (params.channels) channels = params.channels;
    if (channels.length < 1) return false;
    
    if (params.nickservnick) nickservnick = params.nickservnick;
    if (params.nickpass) nickpass = params.nickpass;
    if (params.ident) ident = params.ident;
    if (params.realname) realname = params.realname;
    
    return true;
}


exports.connect = function() {

    client = new irc.Client(serverhost, nickname, {
        port: port,
        secure: ssl,
        channels: channels,
        userName: ident,
        realName: realname,
        floodProtection: true,
        floodProtectionDelay: 500,
        stripColors: false,
        password: null
    });
    
    client.addListener('error', function(message) {
        for (var i = 0; i < cbError.length; i++) {
            if (cbError[i](envname, JSON.stringify(message, null, 4))) {
                break;
            }
        }
    });
    
    client.addListener('message', function(from, to, message, messageObj) {
        var type = "regular";
        if (to[0] != "#") type = "private";
        for (var i = 0; i < cbMessage.length; i++) {
            if (cbMessage[i](envname, type, message, from + '!' + messageObj.user + '@' + messageObj.host, messageObj)) {
                break;
            }
        }
    });
    
    client.addListener('action', function(from, to, message, messageObj) {
        var type = "action";
        if (to[0] != "#") type = "privateaction";
        for (var i = 0; i < cbMessage.length; i++) {
            if (cbMessage[i](envname, type, message, from + '!' + messageObj.user + '@' + messageObj.host, messageObj)) {
                break;
            }
        }
    });
    
    client.addListener('notice', function(from, to, message, messageObj) {
        if (nickpass && from && nickservnick && from.toLowerCase() == nickservnick.toLowerCase()) {
            if (/This.*nickname.*registered/i.exec(message)) {
                client.say(nickservnick, "IDENTIFY " + nickpass);
            }
        }
    });
    
    //Keep track of people
    
    client.addListener('join', function(channel, nick, messageObj) {
        addPeople(nick, [channel], messageObj);
        if (nick.toLowerCase() == nickname.toLowerCase()) {
            client.send('WHO', channel);
        }
    });
    
    client.addListener('part', function(channel, nick) {
        remPeople(nick, [channel]);
    });
    
    client.addListener('quit', function(nick, x, channels) {
        remPeople(nick, channels);
    });
    
    client.addListener('kick', function(channel, nick) {
        remPeople(nick, [channel]);
    });
    
    client.addListener('nick', function(oldnick, newnick, channels, messageObj) {
        remPeople(oldnick, channels);
        addPeople(newnick, channels, messageObj);
    });
    
    client.addListener('raw', function(messageObj) {
        if (messageObj.rawCommand == 005) { //VERSION reply
            for (var i = 0; i < messageObj.args.length; i++) {
                var getprefs;
                if (getprefs = messageObj.args[i].match(/PREFIX=\([^\)]+\)(.+)/)) {
                    prefixes = getprefs[1].split('');
                }
            }
        }
        if (messageObj.rawCommand == 352) { //WHO reply
            addPeople(messageObj.args[5], [messageObj.args[1]], {user: messageObj.args[2], host: messageObj.args[3]});
        }
        if (messageObj.rawCommand == 307) { //WHOIS reply - identified
            people[messageObj.args[0]].identified = true;
        }
        if (messageObj.rawCommand == 671) { //WHOIS reply - secured
            people[messageObj.args[0]].secured = true;
        }
    });
}


exports.disconnect = function() {
    client.disconnect();
}


exports.msg = function(targetid, msg) {
    if (!targetid) targetid = channels[0];
    
    var parts;
    
    if (parts = targetid.match(/^([^!]+)![^@]+@.+$/)) {
        client.say(parts[1], msg);
    }
    if (parts = targetid.match(/^#.+$/)) {
        client.say(targetid, msg);
    }
    
}


exports.registerOnError = function(func) {  //callback(env, errormsg)
    cbError.push(func);
}


exports.registerOnMessage = function(func) {  //callback(env, type, message, author, rawobject)
    cbMessage.push(func);
}


exports.idToDisplayName = function(id) {
    var parts = id.split("!");
    return parts[0];
}


exports.displayNameToId = function(displayname) {
    if (people[displayname]) {
        return people[displayname].id;
    }
    return null;
}


exports.idIsSecured = function(id) {
    var parts = id.split("!");
    var person = people[parts[0]];
    return (person && person.secured);
}


exports.idIsAuthenticated = function(id) {
    var parts = id.split("!");
    var person = people[parts[0]];
    return (person && person.identified);
}


exports.getRawObject = function() {
    return client;
}


//Auxiliary


function addPeople(nick, channels, messageObj) {
    if (!messageObj) return false;
    if (!people[nick]) {
        people[nick] = {
            id: null,
            channels: [],
            identified: false,
            secured: false
        }
        client.send('WHOIS ', nick);
    }
    people[nick].id = nick + '!' + messageObj.user + '@' + messageObj.host;
    for (var i = 0; i < channels.length; i++) {
        people[nick].channels.push(channels[i]);
    }
    return true;
}

function remPeople(nick, channels) {
    if (!people[nick]) return false;
    var newchans = people[nick].channels.filter(function(chan) {
        return !channels.find(function(remchan) { return remchan == chan; });
    });
    if (newchans.length) {
        people[nick].channels = newchans;
    } else {
        delete people[nick];
    }
    return true;
}
