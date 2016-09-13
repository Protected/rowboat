// Dependencies
var jsonfile = require('jsonfile');
var discord = require('discord.js');

var proto = EnvDiscord.prototype;

/**
 *  Environment: Discord -- This environment connects to a Discord server/guild.
 */
function EnvDiscord(){
    //== Environment settings (discord.env.json)

    //*Discord application token
    this._token = null;
    //*Server name to operate on (application must have been previously added to server)
    this._servername = null;
    //*Default channel to operate on (must be a channel in the above server)
    this._defaultchannel = null;
    //Send delay (ms)
    this._senddelay = 500;
    //==

    //Class-specific
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
    function run() {
        var attr = attributes[idx];

        Object.defineProperty(proto, attr, {
            configurable: true,
            get: function () {
                var attributeFinal = '_'+attr;
                return this[attributeFinal];
            },
            set: function (value) {
                var attributeFinal = '_'+attr;
                this[attributeFinal] = value;
            }
        });
    }
    run();
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
        if (!this.token) return false;

        if (params.servername) this.servername = params.servername;
        if (!this.servername) return false;

        if (params.defaultchannel) this.defaultchannel = params.defaultchannel;
        if (!this.defaultchannel) return false;

        if (params.senddelay) this.senddelay = params.senddelay;

        return true;
    }
});
//Connects to the environment
Object.defineProperty(proto, 'connect', {
    configurable: true,
    value: function () {
        this.client = new discord.Client();

        var self = this;

        this.client.on("ready", function(message) {
            self.server = self.client.servers.get("name", self.servername);
            self.channels[self.server.defaultChannel.name] = self.server.defaultChannel;
            if (self.defaultchannel != self.server.defaultChannel.name) {
                self.channels[self.defaultchannel] = self.server.channels.getAll("type", "text").get("name", self.defaultchannel);
            }
            self.carrier = setInterval(function() { self.deliverMsgs.apply(self,null) }, self.senddelay);
        });

        this.client.on("message", function(message) {

            if (message.author.username == self.client.user.username) return;

            var type = "regular";
            var channelid = message.channel.id;
            if (message.channel instanceof discord.PMChannel) {
                type = "private";
                channelid = message.author.id;
            }

            for (var i = 0; i < self.cbMessage.length; i++) {
                if (self.cbMessage[i](self.envname, type, message.content, message.author.id, channelid, message)) {
                    break;
                }
            }
        });

        this.client.loginWithToken(this.token, this.genericErrorHandler);
    }
});
// Disconnects from the environment.
Object.defineProperty(proto, 'disconnect', {
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
            targetchan = this.channels[this.defaultchannel];
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
        for (var i = 0; this.outbox && i < this.outbox.length; i++) {
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








