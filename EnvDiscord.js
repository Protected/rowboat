/* Environment: Discord -- This environment connects to a Discord server/guild. */

var jsonfile = require('jsonfile');
var discord = require('discord.js');

//== Environment settings (discord.env.json)

//*Discord application token
var token = null;

//*Server name to operate on (application must have been previously added to server)
var servername = null;

//*Default channel to operate on (must be a channel in the above server)
var defaultchannel = null;

//Send delay (ms)
var senddelay = 500;

//== 

var client = null;
var server = null;
var channels = {};
var outbox = [];
var carrier = null;

var cbError = [];
var cbMessage = [];


var envname = "Discord";
exports.name = envname;


exports.initialize = function() {
    var params = {};
    try {
        params = jsonfile.readFileSync("discord.env.json");
    } catch(e) {}
    
    if (params.token) token = params.token;
    if (!token) return false;
    
    if (params.servername) servername = params.servername;
    if (!servername) return false;
    
    if (params.defaultchannel) defaultchannel = params.defaultchannel;
    if (!defaultchannel) return false;
    
    if (params.senddelay) senddelay = params.senddelay;
    
    return true;
}


exports.connect = function() {

    client = new discord.Client();

    client.on("ready", function(message) {
        server = client.servers.get("name", servername);
        channels[server.defaultChannel.name] = server.defaultChannel;
        if (defaultchannel != server.defaultChannel.name) {
            channels[defaultchannel] = server.channels.getAll("type", "text").get("name", defaultchannel);
        }
    });
    
    client.on("message", function(message) {
    
        if (message.author.username == client.user.username) return;
        
        var type = "regular";
        channelid = message.channel.id;
        if (message.channel instanceof discord.PMChannel) {
            type = "private";
            channelid = message.author.id;
        }
        
        for (var i = 0; i < cbMessage.length; i++) {
            if (cbMessage[i](envname, type, message.content, message.author.id, channelid, message)) {
                break;
            }
        }
    });

    client.loginWithToken(token, genericErrorHandler);

    carrier = setInterval(deliverMsgs, senddelay);
}


exports.disconnect = function() {
    if (carrier) clearInterval(carrier);
    if (client) client.logout(genericErrorHandler);
    carrier = null;
    client = null;
}


exports.msg = function(targetid, msg) {

    var targetchan = null;
    
    if (typeof targetid == "string") {
        if (!channels[targetid]) {
            channels[targetid] = server.channels.getAll("type", "text").get("id", targetid);
        }
        if (!channels[targetid]) {
            channels[targetid] = server.members.get("id", targetid);
        }
        if (!channels[targetid]) {
            channels[targetid] = server.channels.getAll("type", "text").get("name", targetid);
        }
        if (!channels[targetid]) {
            channels[targetid] = server.members.get("name", targetid);
        }
        if (channels[targetid]) {
            targetchan = channels[targetid];
        }
    } else {
        targetchan = targetid;
    }
    
    if (!targetchan) {
        targetchan = channels[defaultchannel];
    }
    
    outbox.push([targetchan, msg]);
}


exports.registerOnError = function(func) {  //callback(env, errormsg)
    cbError.push(func);
}


exports.registerOnMessage = function(func) {  //callback(env, type, message, authorid, rawobject)
    cbMessage.push(func);
}


exports.idToDisplayName = function(id) {
    var user = server.members.get("id", id);
    if (user) {
        var disp = server.detailsOfUser(user).nick;
        if (!disp) disp = user.username;
        return disp;
    }
    return id;
}

    
exports.displayNameToId = function(displayname) {
    var refuser = null;
    
    var parts = displayname.split("#");
    if (parts[1]) {
        refuser = server.members.getAll("username", parts[0]).get("discriminator", parts[1]);
    } else {
        var cache = server.members.getAll("username", displayname);
        if (cache.length == 1) {
            refuser = cache[0];
        } else {
            displayname = displayname.toLowerCase();
            for (var i = 0; i < server.members.length; i++) {
                var nick = server.detailsOfUser(server.members[i]).nick;
                if (nick && nick.toLowerCase() == displayname) {
                    refuser = server.members[i];
                    break;
                }
            }
        }
    }
    
    if (refuser) {
        return refuser.id;
    }
    
    return null;
}


exports.idIsSecured = function(id) {
    return true;
}


exports.idIsAuthenticated = function(id) {
    return true;
}


exports.getRawObject = function() {
    return {
        "client": client,
        "server": server
    }
}


//Auxiliary


function genericErrorHandler(err) {
    if (!err) return;
    for (var i = 0; i < cbError.length; i++) {
        if (cbError[i](envname, err)) {
            break;
        }
    }
}


function deliverMsgs() {
    var packages = {};
    for (var i = 0; i < outbox.length; i++) {
        var rawchannelid = outbox[i][0].id;
        if (!packages[rawchannelid]) {
            packages[rawchannelid] = {
                targetchan: outbox[i][0],
                messages: []
            }
        }
        packages[rawchannelid].messages.push(outbox[i][1]);
    }
    for (var rawchannelid in packages) {
        try {
            client.sendMessage(
                packages[rawchannelid].targetchan,
                packages[rawchannelid].messages.join("\n"),
                {disableEveryone: true},
                genericErrorHandler
            );
        } catch (e) {
            genericErrorHandler(e.message);
        }
    }
    outbox = [];
}

