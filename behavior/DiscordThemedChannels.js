/* Module: DiscordThemedChannels -- Index and manage Discord channels whose purpose is to contain lists of embeds. */

const Module = require('../Module.js');

const random = require('meteor-random');
const { EmbedBuilder } = require('discord.js');

class ModDiscordThemedChannels extends Module {

    //If redirect is present, rejected messages will be deleted and posted in the target channel by the bot (new messages only)

    get requiredParams() { return [
        'channels'               //{NAME: {env: ENVNAME, id: CHANNELID, types: [TYPE, ...], redirect: CHANNELID}} 
    ]; }

    get optionalParams() { return [
        'strict'                //If true, messages must ONLY contain the listed embed types.
    ]; }
   
    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    denv(chan) {
        return this.env(this.param('channels')[chan].env);
    }

    dchan(chan) {
        return this.denv(chan).server.channels.cache.get(this.param('channels')[chan].id);
    }


    constructor(name) {
        super('DiscordThemedChannels', name);

        this._params["strict"] = false;

        this._index = {};  //{CHANNELID: {ID: MESSAGE, ...}}
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        for (let chan in this.param("channels")) {
            if (this.denv(chan).envName != "Discord") return false;
        }


        //Register handlers

        let messageHandler = (message) => {
            if (message.author.id == message.guild?.me.id) return;
            let chansets = this.chansetsByChannelid(message.channel.id);
            if (!chansets) return;
            if (this.messageFitsTheme(message, chansets.types)) {
                this._index[message.channel.id][message.id] = message;
                return;
            } 
            if (chansets.redirect) {
                let redirectchannel = message.channel.guild.channels.cache.get(chansets.redirect);
                if (redirectchannel) {
                    message.delete()
                        .then(() => {
                            this.denv(chan).msg(redirectchannel, "**" + message.member.displayName + "** in <#" + message.channel.id + ">: " + message.content);
                        });
                }
            }
        };

        let messageUpdateHandler = (oldMessage, message) => {
            let chansets = this.chansetsByChannelid(message.channel.id);
            if (!chansets) return;
            if (!this.messageFitsTheme(oldMessage, chansets.types) && this.messageFitsTheme(message, chansets.types)) {
                this._index[message.channel.id][message.id] = message;
            }
            if (this.messageFitsTheme(oldMessage, chansets.types) && !this.messageFitsTheme(message, chansets.types)) {
                delete this._index[message.channel.id][message.id];
            }
        };

        let messageDeleteHandler = (message) => {
            if (this._index[message.channel.id] && this._index[message.channel.id][message.id]) {
                delete this._index[message.channel.id][message.id];
            }
        };

        let chansbyenv = {};

        for (let chan in this.param("channels")) {
            let chansets = this.param("channels")[chan];
            if (!chansbyenv[chansets.env]) chansbyenv[chansets.env] = {};
            chansbyenv[chansets.env][chan] = chansets;
        }

        for (let env in chansbyenv) {
            this.env(env).on("connected", async () => {

                //Prefetch and index channel contents

                for (let chan in chansbyenv[env]) {
                    let chansets = chansbyenv[env][chan];
                    this._index[chansets.id] = {};
                    
                    this.env(env).scanEveryMessage(this.dchan(chan), (message) => {
                        if (this.messageFitsTheme(message, chansets.types)) {
                            this._index[chansets.id][message.id] = message;
                        }
                    });
                }

                this.env(env).client.on("messageCreate", messageHandler);
                this.env(env).client.on("messageUpdate", messageUpdateHandler);
                this.env(env).client.on("messageDelete", messageDeleteHandler);
            });
        }


        //Register commands

        this.mod('Commands').registerCommand(this, 'tcany', {
            description: "Obtain a random message from a themed channel.",
            args: ["chan"]
        },  async (env, type, userid, channelid, command, args, handle, ep) => {
            
            let chansets = this.param('channels')[args.chan];
            if (!chansets) {
                ep.reply("Channel unknown. Available channels: " + Object.keys(this.param('channels')).filter(chan => this.param('channels')[chan].env == env.name));
                return true;
            }
            if (chansets.env != env.name) {
                return true;
            }

            let messageids = Object.keys(this._index[chansets.id]);
            let pickmsg = this._index[chansets.id][messageids[Math.floor(random.fraction() * messageids.length)]];

            if (!pickmsg) {
                ep.reply("No messages found yet!");
                return true;
            }

            let embeds = pickmsg.embeds.values();
            let pickembed = embeds[Math.floor(random.fraction() * embeds.length)];

            if (!pickembed && chansets.types.includes("image")) {
                let attachments = [...pickmsg.attachments.values()].filter(att => att.width);
                let pickatt = attachments[Math.floor(random.fraction() * attachments.length)];
                if (pickatt) {
                    pickembed = new EmbedBuilder().setImage(pickatt.url);
                }
            }

            if (!pickembed) {
                ep.reply("No content in indexed message.");
                return true;
            }

            let channel;
            if (userid == channelid) {
                channel = await env.client.realClient.users.fetch(userid).then(user => user.createDM());
            } else {
                channel = env.server.channels.cache.get(channelid);
            }

            env.msg(channel, "https://discord.com/channels/" + env.server.id + "/" + pickmsg.channel.id + "/" + pickmsg.id, pickembed);

            return true;
        });

        
        return true;
    }
        
    
    // # Module code below this line #
    
    chansetsByChannelid(channelid) {
        for (let chan in this.param('channels')) {
            let chansets = this.param('channels')[chan];
            if (chansets.id == channelid) {
                return chansets;
            }
        }
        return null;
    }

    messageFitsTheme(message, types) {
        let embeds = message.embeds;
        let attachments = message.attachments;
        if (!embeds.length && !attachments.size) return false;

        let inctypes = false, notypes = false;

        if (embeds.length) {
            inctypes = true;
        }

        //TODO fix this
        for (let att of attachments.values()) {
            if (att.width && types.includes("image") || types.includes(att.contentType)) {
                inctypes = true;
            }
            if (!att.width && types.find(type => type != "image")) {
                notypes = true;
            }
        }

        return inctypes && (!this.param("strict") || !notypes);
    }


}


module.exports = ModDiscordThemedChannels;
