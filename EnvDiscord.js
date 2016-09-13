// Dependencies
var jsonfile = require('jsonfile');
var discord = require('discord.js');

var proto = EnvDiscord.prototype;

/**
 *  Environment: Discord -- This environment connects to a Discord server/guild.
 */
function EnvDiscord(){
    this._token = null;
    this._servername = null;
    this._defaultchannel = null;
    this._senddelay = 500;
    this._client = null;
    this._server = null;
    this._channels = {};
    this._outbox = [];
    this._carrier = null;
    this._cbError = [];
    this._cbMessage = [];
    this._envname = "Discord";

}
var attributes = ["token","servername","defaultchannel","senddelay","client"
                 ,"server","channels","outbox","carrier","cbError","cbMessage","envname"];

for(var idx in attributes) {
    let attr = attributes[idx];
    Object.defineProperty(proto, attr, {
        configurable: true,
        get: function () {
            return this['_'+attr];
        },
        set: function (value) {
            this['_'+attr] = value;
        }
    });
}
//Initializes the environment.
Object.defineProperty(proto, 'initialize', {
    configurable: true,
    value: function () {
        var params = {};
        try {
            params = jsonfile.readFileSync("discord.env.json");
        } catch(e) {}

        if (params.token) this.token = params.token;
        if (!token) return false;

        if (params.servername) this.servername = params.servername;
        if (!servername) return false;

        if (params.defaultchannel) this.defaultchannel = params.defaultchannel;
        if (!defaultchannel) return false;

        if (params.senddelay) this.senddelay = params.senddelay;

        return true;
    }
});
//Connects to the environment
Object.defineProperty(proto, 'connect', {
    configurable: true,
    value: function () {
        this.client = new discord.Client();

        this.client.on("ready", function(message) {
            this.server = this.client.servers.get("name", servername);
            this.channels[this.server.defaultChannel.name] = this.server.defaultChannel;
            if (this.defaultchannel != this.server.defaultChannel.name) {
                this.channels[this.defaultchannel] = this.server.channels.getAll("type", "text").get("name", this.defaultchannel);
            }
        });

        this.client.on("message", function(message) {

            if (message.author.username == this.client.user.username) return;

            var type = "regular";
            var channelid = message.channel.id;
            if (message.channel instanceof discord.PMChannel) {
                type = "private";
                channelid = message.author.id;
            }

            for (var i = 0; i < this.cbMessage.length; i++) {
                if (this.cbMessage[i](this.envname, type, message.content, message.author.id, channelid, message)) {
                    break;
                }
            }
        });

        this.client.loginWithToken(token, genericErrorHandler);
        this.carrier = setInterval(this.deliverMsgs, this.senddelay);
    }
});
// Disconnects from the environment.
Object.defineProperty(proto, 'initialize', {
    configurable: true,
    value: function () {
        if (this.carrier) clearInterval(this.carrier);
        if (this.client) this.client.logout(genericErrorHandler);
        this.carrier = null;
        this.client = null;
    }
});
// Sends a message
Object.defineProperty(proto, 'msg', {
    configurable: true,
    value: function (targetid, msg) {
        var targetchan = null;

        if (typeof targetid == "string") {
            if (!this.channels[targetid]) {
                this.channels[targetid] = this.server.channels.getAll("type", "text").get("id", targetid);
            }
            if (!this.channels[targetid]) {
                this.channels[targetid] = this.server.members.get("id", targetid);
            }
            if (!this.channels[targetid]) {
                this.channels[targetid] = this.server.channels.getAll("type", "text").get("name", targetid);
            }
            if (!this.channels[targetid]) {
                this.channels[targetid] = this.server.members.get("name", targetid);
            }
            if (this.channels[targetid]) {
                targetchan = this.channels[targetid];
            }
        } else {
            targetchan = targetid;
        }

        if (!targetchan) {
            targetchan = this.channels[defaultchannel];
        }

        this.outbox.push([targetchan, msg]);
    }
});
// Registers an error
Object.defineProperty(proto, 'registerOnError', {
    configurable: true,
    value: function (func) {
        this.cbError.push(func);
    }
});
// Registers a message
Object.defineProperty(proto, 'registerOnMessage', {
    configurable: true,
    value: function (func) {
        this.cbMessage.push(func);
    }
});
// Converts id to display Name
Object.defineProperty(proto, 'idToDisplayName', {
    configurable: true,
    value: function (id) {
        var user = this.server.members.get("id", id);
        if (user) {
            var disp = this.server.detailsOfUser(user).nick;
            if (!disp) disp = user.username;
            return disp;
        }
        return id;
    }
});
// Converts display Name to id
Object.defineProperty(proto, 'displayNameToId', {
    configurable: true,
    value: function (displayname) {
        var refuser = null;

        var parts = displayname.split("#");
        if (parts[1]) {
            refuser = this.server.members.getAll("username", parts[0]).get("discriminator", parts[1]);
        } else {
            var cache = this.server.members.getAll("username", displayname);
            if (cache.length == 1) {
                refuser = cache[0];
            } else {
                displayname = displayname.toLowerCase();
                for (var i = 0; i < this.server.members.length; i++) {
                    var nick = this.server.detailsOfUser(this.server.members[i]).nick;
                    if (nick && nick.toLowerCase() == displayname) {
                        refuser = this.server.members[i];
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
});
// Id is secured
Object.defineProperty(proto, 'idIsSecured', {
    configurable: true,
    value: function (id) {
        return true;
    }
});
// Id is authenticated
Object.defineProperty(proto, 'idIsAuthenticated', {
    configurable: true,
    value: function (id) {
        return true;
    }
});
// Raw object
Object.defineProperty(proto, 'getRawObject', {
    configurable: true,
    value: function () {
        return {
            "client": this.client,
            "server": this.server
        }
    }
});
// Generic error handler
Object.defineProperty(proto, 'genericErrorHandler', {
    configurable: true,
    value: function (err) {
        if (!err) return;
        for (var i = 0; i < this.cbError.length; i++) {
            if (this.cbError[i](this.envname, err)) {
                break;
            }
        }
    }
});
// Deliver Messages
Object.defineProperty(proto, 'deliverMsgs', {
    configurable: true,
    value: function () {
        var packages = {};
        for (var i = 0; i < this.outbox.length; i++) {
            var rawchannelid = this.outbox[i][0].id;
            if (!packages[rawchannelid]) {
                packages[rawchannelid] = {
                    targetchan: this.outbox[i][0],
                    messages: []
                }
            }
            packages[rawchannelid].messages.push(this.outbox[i][1]);
        }
        for (var rawchannelid in packages) {
            try {
                this.client.sendMessage(
                    packages[rawchannelid].targetchan,
                    packages[rawchannelid].messages.join("\n"),
                    {disableEveryone: true},
                    this.genericErrorHandler
                );
            } catch (e) {
                this.genericErrorHandler(e.message);
            }
        }
        this.outbox = [];
    }
});



//noinspection JSUnresolvedVariable
module.exports = EnvDiscord;


/*

exports.name = envname;
exports.connect = function() {
exports.disconnect = function() {
exports.msg = function(targetid, msg) {
exports.registerOnError = function(func) {  //callback(env, errormsg)
exports.registerOnMessage = function(func) {  //callback(env, type, message, authorid, rawobject)
exports.idToDisplayName = function(id) {
exports.displayNameToId = function(displayname) {
exports.idIsSecured = function(id) {
exports.idIsAuthenticated = function(id) {
exports.getRawObject = function() {
function genericErrorHandler(err) {
function deliverMsgs() {
*/








