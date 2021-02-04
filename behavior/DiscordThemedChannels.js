/* Module: DiscordThemedChannels -- Index and manage Discord channels whose purpose is to contain lists of embeds. */

const Module = require('../Module.js');

const random = require('meteor-random');
const e = require('express');
const { MessageEmbed } = require('discord.js');

class ModDiscordThemedChannels extends Module {

    //Channel types: https://discord.js.org/#/docs/main/master/class/MessageEmbed?scrollTo=type
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
            let chansets = this.chansetsByChannelid(message.channel.id);
            if (!chansets) return;
            if (this.messageFitsTheme(message, chansets.types)) {
                this._index[message.channel.id][message.id] = message;
                return;
            } 
            if (chansets.redirect) {
                let redirectchannel = message.channel.guild.channels.cache.get(chansets.redirect);
                if (redirectchannel) {
                    message.delete({reason: "Redirecting to " + chansets.redirect})
                        .then(() => {
                            redirectchannel.send("**" + message.member.displayName + "** in <#" + message.channel.id + ">: " + message.content);
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

                this.env(env).client.on("message", messageHandler);
                this.env(env).client.on("messageUpdate", messageUpdateHandler);
                this.env(env).client.on("messageDelete", messageDeleteHandler);
            });
        }


        //Register commands

        this.mod('Commands').registerCommand(this, 'tcany', {
            description: "Obtain a random message from a themed channel.",
            args: ["chan"]
        },  (env, type, userid, channelid, command, args, handle, ep) => {
            
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

            let embeds = pickmsg.embeds.filter(embed => chansets.types.includes(embed.type));
            let pickembed = embeds[Math.floor(random.fraction() * embeds.length)];

            if (!pickembed && chansets.types.includes("image")) {
                let attachments = pickmsg.attachments.array().filter(att => att.width);
                let pickatt = attachments[Math.floor(random.fraction() * attachments.length)];
                if (pickatt) {
                    pickembed = new MessageEmbed().setImage(pickatt.url);
                }
            }

            if (!pickembed) {
                ep.reply("No content in indexed message.");
                return true;
            }

            let channel = env.server.channels.cache.get(channelid);
            channel.send("https://discord.com/channels/" + env.server.id + "/" + pickmsg.channel.id + "/" + pickmsg.id, pickembed);

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
        let attachments = message.attachments.array();
        if (!embeds.length && !attachments.length) return false;

        let inctypes = false, notypes = false;

        for (let embed of embeds) {
            if (types.includes(embed.type)) {
                inctypes = true;
            } else {
                notypes = true;
            }
        }

        for (let att of attachments) {
            if (att.width && types.includes("image")) {
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
