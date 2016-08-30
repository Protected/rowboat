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
            if (cbError[i](envname, message)) {
                break;
            }
        }
    });
    
    client.addListener('message', function (from, to, message, messageObj) {
        var type = "regular";
        if (to[0] != "#") type = "private";
        for (var i = 0; i < cbMessage.length; i++) {
            if (cbMessage[i](envname, type, message, from, messageObj)) {
                break;
            }
        }
    });
    
    client.addListener('action', function (from, to, message, messageObj) {
        var type = "action";
        if (to[0] != "#") type = "privateaction";
        for (var i = 0; i < cbMessage.length; i++) {
            if (cbMessage[i](envname, type, message, from, messageObj)) {
                break;
            }
        }
    });
    
    client.addListener('notice', function (from, to, message, messageObj) {
        if (nickpass && from && nickservnick && from.toLowerCase() == nickservnick.toLowerCase()) {
            if (/This.*nickname.*registered/i.exec(message)) {
                client.say(nickservnick, "IDENTIFY " + nickpass);
            }
        }
    });
}


exports.disconnect = function() {
    client.disconnect();
}


exports.msg = function(target, msg) {
    if (!target) target = channels[0];
    client.say(target, msg);
}


exports.registerOnError = function(func) {  //callback(env, errormsg)
    cbError.push(func);
}


exports.registerOnMessage = function(func) {  //callback(env, type, message, author, rawobject)
    cbMessage.push(func);
}


exports.getRawObject = function() {
    return client;
}
