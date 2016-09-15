/* Environment: IRC -- This environment connects to an IRC server. */

var Environment = require('./Environment.js');
var irc = require('irc');

class EnvIRC extends Environment {


    get requiredParams() { return [
        'serverhost',           //IP address or hostname of the IRC server
        'nickname',             //Nickname for the connection
        'channels'              //List of channels to join (each item is a string representing a channel name)
    ]; }
    
    get optionalParams() { return [
        'port',                 //Port of the IRC server
        'ssl',                  //Use SSL connection
        'nickservnick',         //Nickserv's nickname
        'nickpass',             //Nickserv password
        'ident',                //Username
        'realname',             //Real name
        'senddelay'             //Send delay (ms)
    ]; }
    
    constructor(name) {
        super('IRC', name);
        
        this._params['port'] = 6667;
        this._params['ssl'] = false;
        this._params['nickservnick'] = 'Nickserv';
        this._params['nickpass'] = null;
        this._params['ident'] = 'myshelter';
        this._params['realname'] = 'Not a pun, just a misunderstanding.';
        this._params['senddelay'] = 500;

        this._client = null;
        this._prefixes = [];
        this._people = {};
    }


    connect() {

        var params = this.params;

        this._client = new irc.Client(params.serverhost, params.nickname, {
            port: params.port,
            secure: params.ssl,
            channels: params.channels,
            userName: params.ident,
            realName: params.realname,
            floodProtection: true,
            floodProtectionDelay: params.senddelay,
            stripColors: false,
            password: null
        });
        
        this._client.addListener('error', (message) => {
            this.genericErrorHandler(JSON.stringify(message, null, 4));
        });
    
        this._client.addListener('message', (from, to, message, messageObj) => {
            var type = "regular";
            var authorid = from + '!' + messageObj.user + '@' + messageObj.host;
            var channelid = to;
            if (to[0] != "#") {
                type = "private";
                channelid = authorid;
            }
            for (let callback of this._cbMessage) {
                if (this.invokeRegisteredCallback(callback, [this, type, message, authorid, channelid, messageObj])) {
                    break;
                }
            }
        });
    
        this._client.addListener('action', (from, to, message, messageObj) => {
            var type = "action";
            var authorid = from + '!' + messageObj.user + '@' + messageObj.host;
            var channelid = to;
            if (to[0] != "#") {
                type = "privateaction";
                channelid = authorid;
            }
            for (let callback of this._cbMessage) {
                if (this.invokeRegisteredCallback(callback, [this, type, message, authorid, channelid, messageObj])) {
                    break;
                }
            }
        });
        
        this._client.addListener('notice', (from, to, message, messageObj) => {
            if (params.nickpass && from && params.nickservnick && from.toLowerCase() == params.nickservnick.toLowerCase()) {
                if (/This.*nickname.*registered/i.exec(message)) {
                    this._client.say(params.nickservnick, "IDENTIFY " + params.nickpass);
                }
            }
        });
    
        //Keep track of people
        
        this._client.addListener('join', (channel, nick, messageObj) => {
            this.addPeople(nick, [channel], messageObj);
            if (nick.toLowerCase() == params.nickname.toLowerCase()) {
                this._client.send('WHO', channel);
            }
        });
        
        this._client.addListener('part', (channel, nick) => {
            this.remPeople(nick, [channel]);
        });
        
        this._client.addListener('quit', (nick, x, channels) => {
            this.remPeople(nick, channels);
        });
        
        this._client.addListener('kick', (channel, nick) => {
            this.remPeople(nick, [channel]);
        });
        
        this._client.addListener('nick', (oldnick, newnick, channels, messageObj) => {
            this.remPeople(oldnick, channels);
            this.addPeople(newnick, channels, messageObj);
        });
        
        this._client.addListener('raw', (messageObj) => {
            if (messageObj.rawCommand == '005') { //VERSION reply
                for (let arg of messageObj.args) {
                    var getprefs;
                    if (getprefs = arg.match(/PREFIX=\([^\)]+\)(.+)/)) {
                        this._prefixes = getprefs[1].split('');
                    }
                }
            }
            if (messageObj.rawCommand == '352') { //WHO reply
                this.addPeople(messageObj.args[5], [messageObj.args[1]], {user: messageObj.args[2], host: messageObj.args[3]});
            }
            if (messageObj.rawCommand == '307') { //WHOIS reply - identified
                this._people[messageObj.args[1]].identified = true;
            }
            if (messageObj.rawCommand == '671') { //WHOIS reply - secured
                this._people[messageObj.args[1]].secured = true;
            }
        });
        
    }


    disconnect() {
        if (this._client) this._client.disconnect();
        this._client = null;
    }


    msg(targetid, msg) {
        if (!targetid) targetid = channels[0];
        
        var parts;
        
        try {
            if (parts = targetid.match(/^([^!]+)![^@]+@.+$/)) {
                this._client.say(parts[1], msg);
            }
            if (parts = targetid.match(/^#.+$/)) {
                this._client.say(targetid, msg);
            }
        } catch (e) {
            this.genericErrorHandler(e.message);
        }
    }


    idToDisplayName(id) {
        var parts = id.split("!");
        return parts[0];
    }


    displayNameToId(displayname) {
        if (this._people[displayname]) {
            return this._people[displayname].id;
        }
        return null;
    }


    idIsSecured(id) {
        var parts = id.split("!");
        var person = this._people[parts[0]];
        return (person && person.secured);
    }


    idIsAuthenticated(id) {
        var parts = id.split("!");
        var person = this._people[parts[0]];
        return (person && person.identified);
    }


    //Auxiliary methods

    addPeople(nick, channels, messageObj) {
        if (!messageObj) return false;
        if (!this._people[nick]) {
            this._people[nick] = {
                id: null,
                channels: [],
                identified: false,
                secured: false
            }
            this._client.send('WHOIS ', nick);
        }
        this._people[nick].id = nick + '!' + messageObj.user + '@' + messageObj.host;
        for (let channel of channels) {
            this._people[nick].channels.push(channel);
        }
        return true;
    }

    remPeople(nick, channels) {
        if (!this._people[nick]) return false;
        var newchans = this._people[nick].channels.filter(
            (chan) => !channels.find(
                (remchan) => (remchan == chan)
            )
        );
        if (newchans.length) {
            this._people[nick].channels = newchans;
        } else {
            delete this._people[nick];
        }
        return true;
    }
    
}


module.exports = EnvIRC;
