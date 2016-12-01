/* Environment: Twitch -- This environment connects to a Twitch stream's chat. */

var Environment = require('./Environment.js');
var tmi = require('tmi.js');


class EnvTwitch extends Environment {


    get requiredParams() { return [
        'username',             //Twitch username
        'token',                //OAuth token
        'channels'              //List of channels (streams) to join (each item is a string representing a username prefixed by #)
    ]; }
        
    get optionalParams() { return [
        'senddelay'             //Message queue send delay (ms)
    ]; }

    constructor(name) {
        super('Twitch', name);

        this._params['senddelay'] = 500;
        
        this._client = null;
        
        this._outbox = [];
        this._people = {};
        this._carrier = null;
    }
    
    
    connect() {

        var self = this;
        var params = this.params;

        this.log(`Connecting to ${params.servername}`);

        this._client = new tmi.client({
            connection: {
                reconnect: true,
                reconnectDecay: 1.1,
                reconnectInterval: 5000,
                secure: true
            },
            identity: {
                username: this.param('username'),
                password: this.param('token')
            },
            channels: this.param('channels'),
            logger: this.makeCustomLogger()
        });
        
        
        this._client.on("connected", () => {
            this._carrier = setInterval(() => {
                    self.deliverMsgs.apply(self, null)
                }, this.param('senddelay'));

            this.log("Environment is now ready!");
        });
        

        this._client.on("message", (channel, userstate, message, self) => {
            if (self) return;

            var type = "regular";
            if (userstate.message-type == "action") {
                type = "action";
            } else if (userstate.message-type == "whisper") {
                type = "private";
            }

            for (let callback of this._cbMessage) {
                if (this.invokeRegisteredCallback(callback, [this, type, message, userstate.username, channel, userstate])) {
                    break;
                }
            }
            
        });

        
        this._client.on("join", (channel, username, self) => {
            this.addPeople(nick, [channel]);
            if (self) return;
            this.triggerJoin(username, [channel], null);
        });

        this._client.on("part", (channel, username, self) => {
            this.remPeople(nick, [channel]);
            if (self) return;
            this.triggerPart(username, [channel], null);
        });
        
        
        this._client.connect();
    }
    
    
    disconnect() {
        if (this._carrier) clearInterval(this._carrier);
        if (this._client) this._client.disconnect();
        this.carrier = null;
        this.client = null;
        this.log(`Disconnected from ${this._name}`);
    }
    
    
    msg(targetid, msg) {
        if (!targetid) targetid = this.param('channels')[0];
        this._outbox.push([targetid, msg]);
    }
    
    
    notice(targetid, msg) {
        this.msg(targetid, msg);
    }
    

    idToDisplayName(id) {
        return id;
    }
    
    
    displayNameToId(displayname) {
        return displayname;
    }
    
    
    idToMention(id) {
        return "@" + id;
    }
    
    
    idIsSecured(id) {
        return true;
    }
    
    idIsAuthenticated(id) {
        return true;
    }
    
    
    listUserIds(channel) {
        if (!channel) return [];
        
        if (channel[0] != "#") {
            //Whisper
            if (this._people[channel]) {
                return [this._people[channel].id];
            }
            return [];
        }
        
        //#channel
        var ids = [];
        for (let username in this._people) {
            let desc = this._people[username];
            if (desc.channels.indexOf(channel) > -1) {
                ids.push(desc.id);
            }
        }
        return ids;
    }
    
    
    channelIdToDisplayName(channelid) {
        return channelid;
    }
    
    
    normalizeFormatting(text) {
        return text;
    }
    
    
    applyFormatting(text) {
        //Twitch doesn't support any formatting
        return String(text).replace(/__(.*?)__/g, "$1").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1");
    }
    
    
    //Auxiliary methods
    
    deliverMsgs() {
        var item = this._outbox.shift();
        if (!item) return;
        
        var parts;
        try {
            if (parts = item[0].match(/^#.+$/)) {
                this._client.say(item[0], item[1]);
            } else {
                this._client.whisper(item[0], item[1]);
            }
        } catch (e) {
            this.genericErrorHandler(e.message);
        }
    }
    
    
    addPeople(username, channels) {
        if (!this._people[username]) {
            this._people[username] = {
                id: username,
                channels: channels
            }
        }
        return true;
    }

    remPeople(username, channels) {
        if (!this._people[username]) return false;
        var newchans = this._people[username].channels.filter(
            (chan) => !channels.find(
                (remchan) => remchan == chan
            )
        );
        if (newchans.length) {
            this._people[username].channels = newchans;
        } else {
            delete this._people[username];
        }
        return true;
    }
    
    
    triggerJoin(authorid, channels, info) {
        if (!info) info = {};
        for (let callback of this._cbJoin) {
            for (let channel of channels) {
                if (this.invokeRegisteredCallback(callback, [this, authorid, channel.id, info])) {
                    break;
                }
            }
        }
    }
    
    triggerPart(authorid, channels, info) {
        if (!info) info = {};
        for (let callback of this._cbPart) {
            for (let channel of channels) {
                if (this.invokeRegisteredCallback(callback, [this, authorid, channel.id, info])) {
                    break;
                }
            }
        }
    }
    
    
};


module.exports = EnvTwitch;
