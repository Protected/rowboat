import WebSocket from 'ws';

import Behavior from '../src/Behavior.js';

const RECONNECT_DELAYS = [5, 20, 60, 120, 300];
const AVATAR_URL_TEMPLATE = "/emby/Users/$userid$/Images/Primary?height=40&tag=&quality=100";

export default class EmbyPartyBridge extends Behavior {

    get description() { return "A bridge for chat and events from Emby Party"; }

    get params() { return [
        {n: 'endpoint', d: "URL to the Emby Party bridge webservice endpoint"},
        {n: 'embyurl', d: "URL pointing to the Emby server"}
    ]; }

    get defaults() { return {
        endpoint: "ws://localhost:8196/bridge",
        embyurl: "http://localhost:8096"
    }; }
    
    get requiredEnvironments() { return {
        Discord: 'Discord'
    }; }

    get requiredBehaviors() { return {
        Commands: 'Commands'
    }; }

    get denv() {
        return this.env('Discord');
    }

    constructor(name) {
        super('EmbyPartyBridge', name);

        this._ws = null;
        this._wsreconnect = 0;  //Amount of reconnect attempts
        this._wsfail = true;  //Whether the websocket promise should reject if the connection fails

        this._linkedparties = {};  //{PARTYNAME: {channels: [...], awaiting: [...]}, ...}
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Register callbacks
        
        this.be('Commands').registerCommand(this, 'party link', {
            description: "Exchange events with an ongoing party with the specified name",
            args: ["party", true]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let party = args.party.join(" ");
            
            this._ws.send(JSON.stringify({
                MessageType: "PartyCheck",
                Party: party,
                Data: null
            }));

            if (!this._linkedparties[party]) {
                this._linkedparties[party] = {channels: [], awaiting: []};
            }

            if (!this._linkedparties[party].awaiting.find(targetid => targetid == channelid)) {
                this._linkedparties[party].awaiting.push(channelid);
            }

            return true;
        });

        this.be('Commands').registerCommand(this, 'party unlink', {
            description: "Stop exchanging events with an ongoing party with the specified name",
            args: ["party", true]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let party = args.party.join(" ");

            if (this._linkedparties[party]) {
                this._linkedparties[party].awaiting = this._linkedparties[party].channels.filter(targetid => targetid != channelid);
                this._linkedparties[party].channels = this._linkedparties[party].channels.filter(targetid => targetid != channelid);

                if (this._linkedparties[party].awaiting.length && this._linkedparties[party].channels.length == 0) {
                    delete this._linkedparties[party];
                }
            }

            return true;
        });


        let messageHandler = (env, type, message, authorid, channelid, messageObject) => {
            if (type != "regular" || messageObject.webhookId) return;

            let parties = this.linkedPartiesByChannelId(channelid);
            if (!parties.length) return;

            let payload = {
                Name: messageObject.member.displayName,
                AvatarUrl: messageObject.member.displayAvatarURL({extension: "png", size: 64}),
                Message: message
            };

            for (let party of parties) {
                this._ws.send(JSON.stringify({
                    MessageType: "Chat",
                    Party: party,
                    Data: payload
                }));
            }
            
        };

        this.denv.on("connected", async () => {
            this.denv.on("message", messageHandler);
        });


        this.on("GeneralCommand", ({party, content}) => {
            if (!this._linkedparties[party]) return;

            if (content.Name == "PartyLogMessage") {
            
                this.broadcastToChannels(this._linkedparties[party].channels, `**[${content.Arguments.Type}]** ${content.Arguments.Subject || ""}`)

            }

            if (content.Name == "ChatBroadcast") {

                this.broadcastToChannelsWithHook(
                    content.Arguments.Name,
                    this.param('embyurl') + AVATAR_URL_TEMPLATE.replace(/\$userid\$/, content.Arguments.UserId),
                    this._linkedparties[party].channels,
                    content.Arguments.Message
                );

            }

        });


        this.on("PartyEnded", ({party, content}) => {
            if (!this._linkedparties[party]) return;

            this.broadcastToChannels(this._linkedparties[party].channels, `The party **${party}** has ended.`);

            delete this._linkedparties[party];
        });


        this.on("PartyExists", ({party, content}) => {
            if (!this._linkedparties[party]) return;

            for (let channelid of this._linkedparties[party].awaiting) {
                this._linkedparties[party].channels.push(channelid);
                this.denv.msg(channelid, `Link established to the party **${party}**.`);
            }

            this._linkedparties[party].awaiting = [];
        });


        this.on("PartyMissing", ({party, content}) => {
            if (!this._linkedparties[party]) return;

            for (let channelid of this._linkedparties[party].awaiting) {
                this.denv.msg(channelid, `The party **${party}** doesn't exist.`);
            }

            delete this._linkedparties[party];
        });


        this.initializeWebSocket();
        

        return true;
    };
    

    // # Module code below this line #
    
    async initializeWebSocket() {
        let buildWebsocket = () => new Promise((resolve, reject) => {

            let ws = new WebSocket(this.param("endpoint"));

            let reconnectWebsocket = () => {
                setTimeout(() => {
                    if ([ws.OPEN, ws.CLOSING].includes(this._ws.readyState)) {
                        this._ws.terminate();
                    }
                    buildWebsocket();
                }, 1000 * RECONNECT_DELAYS[Math.min(this._wsreconnect, RECONNECT_DELAYS.length - 1)]);

                this._wsreconnect += 1;

            }

            let connectionError = (err) => {
                this.log("warn", "Websocket error (" + this._wsreconnect + "): " + JSON.stringify(err));
                if (this._wsfail) {
                    reject(err);
                } else {
                    reconnectWebsocket();
                }
            };

            ws.on('error', connectionError);

            ws.on('open', () => {
                this._ws = ws;
                this.log("Established connection to the websocket.");
                this._wsreconnect = 0;
                resolve();
                
            });

            ws.on('message', (data) => {
                let message = JSON.parse(data);
                try {
                    let content = message.Data, party = message.Party;
                    this.emit(message.MessageType.split("-").map((elm, i) => i > 0 ? elm[0].toUpperCase() + elm.substring(1) : elm).join(""), {party, content});
                } catch (e) {
                    this.log("warn", "Could not parse websocket message " + data + " (" + JSON.stringify(e) + ")");
                }
            });

        });

        return buildWebsocket();
    }


    linkedPartiesByChannelId(channelid) {
        return Object.keys(this._linkedparties).filter(party => this._linkedparties[party].channels.find(eachchannelid => eachchannelid == channelid));
    }


    broadcastToChannels(channels, message) {
        for (let channelid of channels) {
            this.denv.msg(channelid, message);
        }
    }


    async broadcastToChannelsWithHook(displayname, avatar, channels, message) {
        for (let channelid of channels) {
            try {
                let channel = this.denv.server.channels.cache.get(channelid);
                let webhook = await this.denv.getCustomWebhook(channel, displayname, displayname, avatar);
                webhook.send(message);
            } catch (e) {}
        }
    }


}
