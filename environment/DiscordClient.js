/* Wrapper that allows multiple environments to use a discord.js client. */

import discord from 'discord.js';

import AsyncEventEmitter from '../src/AsyncEventEmitter.js';

const Events = discord.Events;
const Intents = discord.IntentsBitField.Flags;

const BRIDGE_EVENTS = [
    Events.GuildAuditLogEntryCreate,
    Events.MessageCreate,
    Events.MessageUpdate,
    Events.MessageDelete,
    Events.GuildMemberAdd,
    Events.GuildMemberRemove,
    Events.GuildMemberUpdate,
    Events.PresenceUpdate,
    Events.GuildRoleCreate,  //'roleCreate'
    Events.GuildRoleDelete,  //'roleDelete'
    Events.GuildRoleUpdate,  //'roleUpdate'
    Events.VoiceStateUpdate,
    Events.MessageReactionAdd,
    Events.MessageReactionRemove,
    Events.MessagePollVoteAdd,
    Events.MessagePollVoteRemove,
    Events.ChannelCreate,
    Events.ChannelDelete,
    Events.ChannelUpdate,
    Events.ChannelPinsUpdate,
    Events.ThreadCreate,
    Events.ThreadDelete,
    Events.ThreadUpdate,
    Events.ThreadMemberUpdate,
    Events.ThreadMembersUpdate,
    Events.ThreadListSync,
    Events.WebhooksUpdate,
    Events.InteractionCreate
];

const INTENTS = [
    Intents.Guilds,
    Intents.GuildMembers,
    Intents.GuildWebhooks,
    Intents.GuildVoiceStates,
    Intents.GuildPresences,
    Intents.GuildMessages,
    Intents.GuildMessageReactions,
    Intents.DirectMessages,
    Intents.MessageContent
];

const MAXIMUM_EMBEDS = 10;
const MAXIMUM_LENGTH = 1900;
const MAXIMUM_ATTACH = 8388608;
const MAXIMUM_COMPROWS = 5;
const EXPIRE_QUEUED_MESSAGE = 60; //seconds

export default new class DiscordClient extends AsyncEventEmitter {

    constructor() {
        super();
    
        this._environments = {};

        this._realClient = null;
        this._resolveOnLogin = [];
        
        this._outbox = [];
        this._carrier = null;

        this._reactionbox = [];
        this._reactioncarrier = null;
        this._reactioncap = 30;
        
        this._sendDelay = 500;
        this._token = null;
    }
    
    
    get realClient() {
        return this._realClient;
    }
    
    
    async prepareClient(envDiscord, token, sendDelay) {
        this._sendDelay = sendDelay;
        
        this._environments[envDiscord.name] = envDiscord;
        
        if (this._realClient) {
            return new Promise((resolve) => {
                this._resolveOnLogin.push(resolve);
            });
        }
        
        this._token = token;
        
        this._realClient = new discord.Client({
            partials: Object.values(discord.Partials),
            intents: INTENTS
        });
        
        this._realClient.on('error', (error) => {
            for (let name in this._environments) {
                this._environments[name].emit('error', 'Serious connection error: ' + error.message);
            }
        });
        
        for (let event of BRIDGE_EVENTS) {
            this._realClient.on(event, (...args) => {
                args.unshift(event);
                this.emit.apply(this, args);
            });
        }

        let self = this;
        this._realClient.once('ready', () => {
            this._carrier = setInterval(() => {
                self.deliverMsgs.apply(self, null);
            }, this._sendDelay);

            this._reactioncarrier = setInterval(() => {
                self.deliverReactions.apply(self, null);
            }, this._sendDelay);
            
            for (let resolve of this._resolveOnLogin) {
                resolve(this._realClient);
            }
        });

        return new Promise((resolve, reject) => {
            this._realClient.login(this._token)
                .catch(e => reject(e));

            this._resolveOnLogin.push(resolve);
        });
    }
    
    
    detachFromClient(envDiscord) {
        if (!this._environments[envDiscord.name]) return Promise.resolve();
        delete this._environments[envDiscord.name];
        if (Object.keys(this._environments).length) return Promise.resolve();
        return this._realClient.destroy()
            .then(() => {
                if (this._carrier) {
                    clearInterval(this._carrier);
                    this._carrier = null;
                }
                this._realClient = null;
            });
    }
    
    
    deliverMsgs() {
        if (!this._outbox?.length) return;

        let now = Date.now();

        //Helper function adds an outboxed message to a package
        let outboxToPackage = (pack, entry, position, item) => {
            pack.messages.push(entry);
            pack.length += (entry.content?.length || 0);
            for (let attachment of entry.attachments || []) {
                pack.attach += attachment.size;
            }
            pack.embed += (entry.embeds?.length || 0);
            pack.comprows += (entry.components?.length || 0);
            pack.resolves.push(item.resolve);
            pack.rejects.push(item.reject)
            this._outbox.splice(position, 1);
            return position - 1;
        }

        //Create one package per channel, containing as many messages as possible (without exceeding limits)
        let packages = {};
        for (let i = 0; this._outbox && i < this._outbox.length; i++) {
            let entry = this._outbox[i].message;
            let rawchannelid = this._outbox[i].channel.id;

            let pack = packages[rawchannelid];
            if (!pack) {
                pack = packages[rawchannelid] = {
                    targetchan: this._outbox[i].channel,
                    messages: [],
                    length: 0,
                    attach: 0,
                    embed: 0,
                    comprows: 0,
                    resolves: [],
                    rejects: []
                };
            }

            if (!pack.messages.length) {
                //Always accept the first message for each channel
                i = outboxToPackage(pack, entry, i, this._outbox[i]);
                continue;
            }

            let reject = false;
            
            if (pack.length + entry.content?.length + 1 > MAXIMUM_LENGTH) {
                //Message makes package contents too long
                reject = true;
            }

            let size = 0;
            for (let attachment of entry.attachments || []) {
                size += attachment.size;
            }
            if (pack.attach + size > MAXIMUM_ATTACH) {
                //Message makes attachments size too large
                reject = true;
            }

            if (pack.embed + (entry.embeds?.length || 0) > MAXIMUM_EMBEDS) {
                //Message adds too many embeds to package
                reject = true;
            }

            if (pack.comprows + (entry.components?.length || 0) > MAXIMUM_COMPROWS) {
                //Message adds too many component rows to package
                reject = true;
            }

            if (pack.messages[0].reply?.messageReference !== entry.reply?.messageReference) {
                //Message is replying to a different message
                reject = true;
            }

            if (!reject) {
                //Message accepted in package
                i = outboxToPackage(pack, entry, i, this._outbox[i]);
            } else if (now - this._outbox[i].ts > EXPIRE_QUEUED_MESSAGE * 1000) {
                //If the message failed to be packaged for delivery on time, discard it
                this._outbox.splice(i, 1);
                i -= 1;
                this._outbox[i].reject("Expired in queue.");
            }
        }
        
        //Deliver packages
        for (let rawchannelid in packages) {
            let pack = packages[rawchannelid];
            
            let realmessage = pack.messages.shift();
            realmessage.tts = false;
            realmessage.allowedMentions = undefined;

            for (let message of pack.messages) {
                if (!realmessage.content) {
                    realmessage.content = message.content;
                } else if (message.content) {
                    realmessage.content = realmessage.content + "\n" + message.content;
                }
                  
                for (let lst of ["embeds", "files", "components", "attachments", "stickers"]) {
                    if (!realmessage[lst]?.length) {
                        realmessage[lst] = message[lst];
                    } else if (message[lst]?.length) {
                        realmessage[lst] = realmessage[lst].concat(message[lst]);
                    }
                }
            }

            pack.targetchan.send(realmessage)
                .then((msg) => {
                    //Resolve promises
                    for (let resolve of pack.resolves) {
                        resolve(msg);
                    }
                })
                .catch((e) => {
                    for (let reject of pack.rejects) {
                        reject(e);
                    }
                });
            
            //List environments that target the server the package was delivered to
            let notifyEnvironments = [];
            for (let name in this._environments) {
                let env = this._environments[name];
                if (env.param('server') == pack.targetchan.guild.id) {
                    notifyEnvironments.push(env);
                }
            }
            
            //Trigger messageSent event on listed environments
            setTimeout(() => {
                for (let env of notifyEnvironments) {
                    env.emit('messageSent', env, env.channelIdToType(pack.targetchan), rawchannelid, realmessage.content);
                }
            }, 1);
        }
        
    }


    deliverReactions() {
        if (!this._reactionbox.length) return;
        let next = this._reactionbox.shift();
        if (!next || next.length != 2) return;
        next[0].react(next[1]);
    }
    
    
    //Outbox a message
    outbox(discordchan, messageoptions) {
        return new Promise((resolve, reject) => {
            this._outbox.push({
                channel: discordchan,
                message: messageoptions,
                ts: Date.now(),
                resolve: resolve,
                reject: reject
            });
        });
    }


    //Outbox a reaction
    reactionbox(discordmsg, emoji) {
        if (this._reactionbox.length >= this._reactioncap) return false;
        this._reactionbox.push([discordmsg, emoji]);
        return true;
    }

}
