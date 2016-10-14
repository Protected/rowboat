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
        
        this._retake = null;
    }


    connect() {

        var self = this;
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

        this.log(`Connecting to ${params.serverhost}.`);
        
        this._client.addListener('error', (message) => {
            this.genericErrorHandler(JSON.stringify(message, null, 4));
        });
        
        
        this._client.addListener('registered', (messageObj) => {
            if (this._client.nick != params.nickname) {
                this.log('warning', "I am " + this._client.nick + " but should be " + params.nickname + "; Will try to retake.");
                this._retake = setInterval(() => {
                    self.retakeNickname.apply(self, null);
                }, 15000);
            }
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
    
        
        this._client.addListener('join', (channel, nick, messageObj) => {
            this.addPeople(nick, [channel], messageObj);
            if (nick.toLowerCase() == params.nickname.toLowerCase()) {
                this._client.send('WHO', channel);
            } 
            this.triggerJoin(nick, [channel], messageObj);
        });
        
        this._client.addListener('part', (channel, nick, reason, messageObj) => {
            this.remPeople(nick, [channel]);
            this.triggerPart(nick, ['part', reason], [channel], messageObj);
        });
        
        this._client.addListener('quit', (nick, reason, channels, messageObj) => {
            this.remPeople(nick, channels);
            this.triggerPart(nick, ['quit', reason], channels, messageObj);
        });
        
        this._client.addListener('kick', (channel, nick, by, reason, messageObj) => {
            this.remPeople(nick, [channel]);
            this.triggerPart(nick, ['kick', reason, by], [channel], messageObj);
        });
        
        this._client.addListener('nick', (oldnick, newnick, channels, messageObj) => {
            this.remPeople(oldnick, channels);
            this.triggerPart(oldnick, ['nick', 'Nickname change', newnick], channels, messageObj);
            this.addPeople(newnick, channels, messageObj);
            this.triggerJoin(newnick, channels, messageObj);
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
    
    
    notice(targetid, msg) {
        if (!targetid) targetid = channels[0];
        
        var parts;
        
        try {
            if (parts = targetid.match(/^([^!]+)![^@]+@.+$/)) {
                this._client.notice(parts[1], msg);
            }
            if (parts = targetid.match(/^#.+$/)) {
                this._client.notice(targetid, msg);
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
        if (!person) return false;
        if (person.identified) return true;
        this._client.send('WHOIS ', parts[0]);
        return false;
    }
    
    
    listUserIds(channel) {
        if (!channel) return [];
        
        if (channel[0] != "#") {
            //PM
            if (this._people[channel]) {
                return [this._people[channel].id];
            }
            return [];
        }
        
        //#channel
        var ids = [];
        for (let nick in this._people) {
            let desc = this._people[nick];
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
        var bold = null;
        var und = null;
        var ita = null;
        var order = [];
        text = String(text).replace(/([0-9]{1,2}(,[0-9]{1,2})?)?/g, "").replace(//g, "") + "";
        for (var i = 0; i < text.length; i++) {
            if (text[i] == "") {
                if (und === null) {
                    und = i;
                    order.push('und');
                } else {
                    text = text.slice(0, und) + "__" + text.slice(und + 1, i) + "__" + text.slice(i + 1);
                    und = null;
                    i += 2;
                    order.splice(order.indexOf('und'), 1);
                }
            } else if (text[i] == "") {
                if (bold === null) {
                    bold = i;
                    order.push('bold');
                } else {
                    text = text.slice(0, bold) + "**" + text.slice(bold + 1, i) + "**" + text.slice(i + 1);
                    bold = null;
                    i += 2;
                    order.splice(order.indexOf('bold'), 1);
                }
            } else if (text[i] == "") {
                if (ita === null) {
                    ita = i;
                    order.push('ita');
                } else {
                    text = text.slice(0, ita) + "*" + text.slice(ita + 1, i) + "*" + text.slice(i + 1);
                    ita = null;
                    order.splice(order.indexOf('ita'), 1);
                }
            } else if (text[i] == "") {
                var insert = '';
                var offset = 0;
                var next = null;
                while (next = order.pop()) {
                    if (next == 'ita' && ita !== null) {
                        text = text.slice(0, ita) + "*" + text.slice(ita + 1);
                        insert += '*';
                    }
                    if (next == 'bold' && bold !== null) {
                        text = text.slice(0, bold) + "**" + text.slice(bold + 1);
                        insert += '**';
                        offset += 1;
                    }
                    if (next == 'und' && und !== null) {
                        text = text.slice(0, und) + "__" + text.slice(und + 1);
                        insert += '__';
                        offset += 1;
                    }
                }
                text = text.slice(0, i + offset) + insert + text.slice(i + offset + 1);
                i += offset + insert.length;
                bold = null;
                und = null;
                ita = null;
            }
        }
        return text;
    }
    
    
    applyFormatting(text) {
        return String(text).replace(/__(.*?)__/g, "$1").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1");
    }


    //Auxiliary methods
    
    
    retakeNickname() {
        this._client.send('NICK ', this.param('nickname'));
        if (this._client.nick == this.param('nickname')) {
            clearInterval(this._retake);
            this._retake = null;
            return;
        }
        if (this.param('nickpass')) {
            this._client.say(this.param('nickservnick'), "GHOST " + this.param('nickname') + " " + this.param('nickpass'));
        }
    }
    

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
    
    
    triggerJoin(nick, channels, messageObj) {
        var authorid = nick + '!' + messageObj.user + '@' + messageObj.host;
        
        for (let callback of this._cbJoin) {
            for (let channelid of channels) {
                if (this.invokeRegisteredCallback(callback, [this, authorid, channelid, messageObj])) {
                    break;
                }
            }
        }
    }
    
    triggerPart(nick, reason, channels, messageObj) {
        var authorid = nick + '!' + messageObj.user + '@' + messageObj.host;
        
        for (let callback of this._cbPart) {
            for (let channelid of channels) {
                if (this.invokeRegisteredCallback(callback, [this, authorid, channelid, reason, messageObj])) {
                    break;
                }
            }
        }
    }
    
}


module.exports = EnvIRC;
