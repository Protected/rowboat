/* Module: ReactionChannels -- Add users to channels based on message reactions. */

const { MessageEmbed } = require('discord.js');

const Module = require('../Module.js');

const PERM_ADMIN = 'administrator';
const CREATE_TYPES = ['text', 'voice'];
const NEUTRAL_COLOR = "#808080";

class ModReactionChannels extends Module {

    get isMultiInstanceable() { return true; }

    get requiredParams() { return [
        "env"
    ]; }

    get optionalParams() { return [
        "channelemojis"         //Map of emoji for channel type representations
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }
    
    get denv() {
        return this.env(this.param('env'));
    }

    constructor(name) {
        super('ReactionChannels', name);

        this._params["channelemojis"] =  {
            text: "",
            voice: "🔈",
            category: "",
            news: "",
            store: "🛒"
        };

        this._data = null;  //{channels: {CHANNELID: {emoji, represent, require}, ...}, embed: {label, color, channel, message}, parent, defs}
        this._emoji = {};  //Index of registered channels by emoji
    }

    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Initialize

        this._data = this.loadData(undefined, {channels: {}, embed: null, parent: null, defs: {}}, {quiet: true});
        this.initializeEmojiIndex();


        //Register callbacks

        let roleDeleteHandler = (role) => {

            for (let channelid in this._data.channels) {
                this.channelRoleUnrelate(channelid, role.id);
            }

        }

        let channelUpdateHandler = (oldChannel, channel) => {

            let chandata = this.getChannel(channel.id);
            if (!chandata) return;

            if (oldChannel.name != channel.name || oldChannel.topic != channel.topic) {
            
                //Automatically update access message on topic changes
                this.updateMessage();

            }

        }

        let channelDeleteHandler = async (channel) => {
            
            //Unregister deleted channels

            let channeldata = this.getChannel(channel.id);
            if (channeldata) {
                if (this._emoji[channeldata.emoji]) {
                    delete this._emoji[channeldata.emoji];
                }

                this.unsetChannel(channel.id);
                this.updateMessage();
            }

            //Detach message if it's in a deleted channel

            let embeddata = this.getEmbedMessage();
            if (embeddata && embeddata.channel == channel.id) {
                this.unsetEmbedMessage();
            }

        }

        let messageDeleteHandler = (message) => {
        
            //Detach deleted message

            let embeddata = this.getEmbedMessage();
            if (embeddata && embeddata.message == message.id) {
                this.unsetEmbedMessage();
            }
            
        };

        let messageReactionAddHandler = async (messageReaction, user) => {
            if (user.id == this.denv.server.me.id) return;

            //Add user to or remove user from channels

            if (!this.isEmbedMessage(messageReaction.message)) return;

            let emoji = this.emojiFromReaction(messageReaction);

            if (this._emoji[emoji]) {
                let channel = this.denv.server.channels.cache.get(this._emoji[emoji]);
                let member = this.denv.server.members.cache.get(user.id);
                if (channel && member) {

                    if (!this.isMemberInChannel(member, channel)) {
                        if (this.hasMemberChannelRequirements(member, channel)) {
                            this.addMemberToChannel(member, channel, "Reacted to " + messageReaction.message.id + " with " + emoji);
                        }
                    } else {
                        this.removeMemberFromChannel(member, channel, "Reacted to " + messageReaction.message.id + " with " + emoji);
                    }

                }
            }
            
            messageReaction.users.remove(user.id);

        };

        let guildMemberUpdateHandler = async (oldMember, member) => {
            if (member.id == this.denv.server.me.id) return;

            //Remove user from channels if requirements are lost

            let currentroles = member.roles.cache.array().map(role => role.id);
            let lostroles = oldMember.roles.cache.array().filter(role => !currentroles.includes(role.id));
            for (let role of lostroles) {
                for (let channelid of this.getChannelsByRequire(role.id)) {
                    let channel = this.denv.server.channels.cache.get(channelid);
                    if (this.isMemberInChannel(member, channel)) {
                        await this.removeMemberFromChannel(member, channel);
                    }
                }
            }
            
        };

        this.denv.on("connected", async () => {

            //Validate channels

            for (let channelid in this._data.channels) {
                if (!this.denv.server.channels.cache.get(channelid)) {
                    this.unsetChannel(channelid);
                }
            }

            //Validate embed message
            
            let embeddata = this.getEmbedMessage();
            if (embeddata && embeddata.message) {
                let message, channel = this.denv.server.channels.cache.get(embeddata.channel);
                if (channel) message = await channel.messages.fetch(embeddata.message);
                if (!channel || !message) {
                    this.unsetEmbedMessage();
                }
            }

            this.denv.client.on("roleDelete", roleDeleteHandler);
            this.denv.client.on("channelUpdate", channelUpdateHandler);
            this.denv.client.on("channelDelete", channelDeleteHandler);
            this.denv.client.on("messageDelete", messageDeleteHandler);
            this.denv.client.on("messageReactionAdd", messageReactionAddHandler);
            this.denv.client.on("guildMemberUpdate", guildMemberUpdateHandler);
        });

        
        //Register commands

        
        this.mod('Commands').registerRootDetails(this, 'rchan', {
            description: "Manage reaction-based channel access assignment.",
            details: [
                "Register channels to associate them with an emoji (for reactions). Channel access can also require roles and provide roles.",
                "Set the embed message to allow people to join/part the channel by reacting to it with the associated emoji."
            ]
        });


        this.mod('Commands').registerCommand(this, 'rchan create', {
            description: "Create a managed channel.",
            args: ["name", "emoji", "type"],
            minArgs: 2
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            if (!args.type) args.type = "text";
            if (!CREATE_TYPES.includes(args.type)) {
                ep.reply("The type must be one of: " + CREATE_TYPES.join(", "));
                return true;
            }

            let name = args.name.trim().toLowerCase();
            if (!name) {
                ep.reply("Please specify a valid channel name.");
                return true;
            }
            name = name.replace(/ /g, "-");

            let emoji = args.emoji;
            if (!this.isEmoji(emoji)) {
                ep.reply("You must specify an emoji to be used in reactions that manipulate this role.");
                return true;
            }

            if (this._emoji[emoji]) {
                ep.reply("This emoji is already in used by another channel (<#" + this._emoji[emoji] + ">).");
                return true;
            }

            let parent = this.getParent();
            if (parent) parent = env.server.channels.cache.get(parent);

            let channel = await env.server.channels.create(name, {
                type: args.type,
                parent: parent,
                permissionOverwrites: [{id: env.server.id, deny: ["VIEW_CHANNEL"]}, {id: userid, allow: ["VIEW_CHANNEL", "MANAGE_CHANNELS", "MANAGE_ROLES"]}],
                reason: "Requested by " + userid + " using rchan create."
            });

            this.setChannel(channel.id, emoji);
            this._emoji[emoji] = channel.id;

            let defaults = this.getDefaults();
            if (defaults.require) {
                for (let relateid of defaults.require) {
                    this.channelRoleRelateRequire(channel.id, relateid);
                }
            }

            this.updateMessage();

            ep.reply("Done.");

            return true;

        });

        this.mod('Commands').registerCommand(this, 'rchan set', {
            description: "Registers an existing channel.",
            args: ["channelid", "emoji"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
    
            let targetchannelid = this.extractChannelId(args.channelid);

            let emoji = args.emoji;
            if (!this.isEmoji(emoji)) {
                ep.reply("You must specify an emoji to be used in reactions that manipulate this role.");
                return true;
            }

            if (this._emoji[emoji] && this._emoji[emoji] != targetchannelid) {
                ep.reply("This emoji is already in used by another channel (<#" + this._emoji[emoji] + ">).");
                return true;
            }

            let channel = env.server.channels.cache.get(targetchannelid);
            if (!channel) {
                ep.reply("Channel not found.");
                return true;
            }

            this.setChannel(channel.id, emoji);
            this._emoji[emoji] = channel.id;

            let defaults = this.getDefaults();
            if (defaults.require) {
                for (let relateid of defaults.require) {
                    this.channelRoleRelateRequire(channel.id, relateid);
                }
            }

            this.updateMessage();

            ep.reply("Ok.");
            
            return true;
        });
    
        this.mod('Commands').registerCommand(this, 'rchan unset', {
            description: "Unregisters a channel.",
            args: ["channelid"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
    
            let targetchannelid = this.extractChannelId(args.channelid);

            let channeldata = this.getChannel(targetchannelid);
            if (this._emoji[channeldata.emoji]) {
                delete this._emoji[channeldata.emoji];
            }

            this.unsetChannel(targetchannelid);

            this.updateMessage();

            ep.reply("Ok.");
    
            return true;
        });


        let relateMultipleRoles = (env, args, ep, relateMethod) => {
            let channelid = this.extractChannelId(args.channelid);
            let targetroleids = this.extractRoleIdsFromCollection(args.targetroleid);
            let checkroles = targetroleids.slice();
            checkroles = checkroles.map(checkroleid => env.server.roles.fetch(checkroleid));
            Promise.all(checkroles)
                .then(roles => {
                    for (let relateid of targetroleids) {
                        if (this.isChannelRoleSomehowRelated(channelid, relateid)) {
                            ep.reply("<#" + channelid + "> already has a prior relationship with " + relateid + ".");
                            continue;
                        }
                        if (relateMethod.call(this, channelid, relateid)) {
                            ep.reply("Relationship established between <#" + channelid + "> and " + relateid + ".");
                        } else {
                            ep.reply("Could not establish relationship between <#" + channelid + "> and " + relateid + ".");
                        }
                    }
                })
                .catch(e => {
                    ep.reply("One or more roles not found.");
                });
            return true;
        }

        this.mod('Commands').registerCommand(this, 'rchan relate represent', {
            description: "When the user joins the channel, the target role is added.",
            details: [
                "When the user leaves the channel, the target role is removed.",
                "The role is not kept even if it's also granted by other channels."
            ],
            args: ["channelid", "targetroleid", true],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => relateMultipleRoles(env, args, ep, this.channelRoleRelateRepresent));

        this.mod('Commands').registerCommand(this, 'rchan relate require', {
            description: "The channel can only be joined if the user has the target role.",
            details: [
                "The loss of the target role results in leaving the channel."
            ],
            args: ["channelid", "targetroleid", true],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => relateMultipleRoles(env, args, ep, this.channelRoleRelateRequire));

        this.mod('Commands').registerCommand(this, 'rchan unrelate', {
            description: "Removes the relationship between the channel and the target role (if any).",
            args: ["channelid", "targetroleid", true],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let targetchannelid = this.extractChannelId(args.channelid);
            let targetroleids = this.extractRoleIdsFromCollection(args.targetroleid);

            if (this.channelRoleUnrelate(targetchannelid, targetroleids)) {
                ep.reply("Ok."); 
            } else {
                ep.reply("Unable to remove relationship.");
            }

            return true;
        });


        let addCollectionToEmbed = async (env, embed, chandata, collection, label) => {
            let roles = chandata[collection];
            if (!roles || !roles.length) return;
            try {
                let checkroles = roles.map(relationroleid => env.server.roles.fetch(relationroleid));
                let checkedroles = await Promise.all(checkroles)
                roles = checkedroles.map(role => role.name);
            } catch (e) {}
            embed.addField(label, roles.join(", "));
        };
        
        this.mod('Commands').registerCommand(this, 'rchan info', {
            description: "Shows information associated with a registered channel.",
            args: ["channelid"]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let targetchannelid = this.extractChannelId(args.channelid);
            let chandata = this.getChannel(targetchannelid);
            if (!chandata) {
                ep.reply("Channel not known.");
                return true;
            }

            let channel = env.server.channels.cache.get(targetchannelid);

            let embed = new MessageEmbed();

            embed.setTitle(this.channelLabel(channel));
            embed.setColor(NEUTRAL_COLOR);
            embed.setDescription(chandata.emoji + (channel.topic ? " " + channel.topic : ""));
            if (channel.type == "text") {
                embed.setURL(this.channelURL(targetchannelid));
            }

            await addCollectionToEmbed(env, embed, chandata, "require", "Requires:");
            await addCollectionToEmbed(env, embed, chandata, "represent", "Represented by:");

            ep.reply(embed);

            return true;
        });


        this.mod('Commands').registerCommand(this, 'rchan list', {
            description: "Lists all the currently registered channels.",
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let channels = this.allChannels();
            let embeddata = this.getEmbedMessage();

            let embed = new MessageEmbed();

            if (embeddata) {
                embed.setTitle(embeddata.label);
                embed.setColor(embeddata.color);
            }

            let description = channels.map(channel => {
                return this.channelLabel(channel) + " (" + channel.id + ")" + (channel.topic ? " " + channel.topic : "");
            }).join("\n");

            let url = this.messageURL();
            if (url) {
                description += "\n\n[Go to message](" + url + ")"; 
            }

            embed.setDescription(description);
            
            if (description) {
                ep.reply(embed);
            } else {
                ep.reply("Nothing to see here. Create some channels and an assignment message.");
            }

            return true;
        });

        
        this.mod('Commands').registerCommand(this, 'rchan message create', {
            description: "Creates a new message for accessing registered channels in the specified channel.",
            args: ["targetchannelid", "color", "label", true],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let targetchannelid = this.extractChannelId(args.targetchannelid) || channelid;

            let color = args.color;
            if (!this.isValidColor(color)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }
            color = color.toLowerCase();

            let embeddata = this.getEmbedMessage();
            if (embeddata?.message) {
                ep.reply("Unassign the previous message first.");
                return true;
            }

            let channel = env.server.channels.cache.get(targetchannelid);
            if (!channel || channel.type != "text") {
                ep.reply("Target channel not found.");
                return true;
            }

            this.setEmbedMessageData(color, args.label.join(" "));
            let embed = await this.generateMessageEmbed();
            let message = await channel.send(embed);
            this.setEmbedMessageAttach(channel.id, message.id);
            this.setupMessageReactions(message);
            ep.reply("Ok.");

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rchan message assign', {
            description: "Uses an existing message for accessing registered channels.",
            args: ["targetchannelid", "messageid", "color", "label", true],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let targetchannelid = this.extractChannelId(args.targetchannelid) || channelid;

            let color = args.color;
            if (!this.isValidColor(color)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }
            color = color.toLowerCase();

            let embeddata = this.getEmbedMessage();
            if (embeddata?.message) {
                ep.reply("Unassign the previous message first.");
                return true;
            }

            let channel = env.server.channels.cache.get(targetchannelid);
            if (!channel || channel.type != "text") {
                ep.reply("Target channel not found.");
                return true;
            }

            try {
                let message = await channel.messages.fetch(args.messageid);
                this.setEmbedMessageData(color, args.label.join(" "));
                let embed = await this.generateMessageEmbed();
                message.edit(embed);
                this.setEmbedMessageAttach(channel.id, message.id);
                this.setupMessageReactions(message);
                ep.reply("Ok.");
            } catch (e) {
                ep.reply("Message not found.");
            };

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rchan message update', {
            description: "Updates the access message.",
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let embeddata = this.getEmbedMessage();
            if (!embeddata?.message) {
                ep.reply("There is no access message yet.");
                return true;
            }

            let result = await this.updateMessage();
            if (result) {
                ep.reply("Ok.");
            } else {
                ep.reply("Message not found.");
            }

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rchan message unassign', {
            description: "Detaches the channel access message (if any).",
            details: [
                "The message will not be deleted automatically."
            ],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let embeddata = this.getEmbedMessage();
            if (!embeddata?.message) {
                ep.reply("There is no access message.");
                return true;
            }           

            this.unsetEmbedMessage();
            ep.reply("Ok.");

            return true;
        });


        this.mod('Commands').registerCommand(this, 'rchan config parent', {
            description: "Set the parent category for new channels created by this module.",
            args: ["categoryid"],
            minArgs: 0,
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let category = null;
            if (args.categoryid && args.categoryid != "-") {
                category = env.server.channels.cache.get(args.categoryid);
                if (!category) {
                    ep.reply("Category not found.");
                    return true;
                }
                if (category.type != "category") {
                    ep.reply("This channel is not a category.");
                    return true;
                }
            }

            if (category) {
                this.setParent(category.id);
                ep.reply("Parent set.");
            } else {
                this.unsetParent();
                ep.reply("Parent cleared.");
            }

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rchan config required', {
            description: "Set the default required roles for new channels created by this module.",
            details: [
                "Required roles can be changed individually for each channel using rchan relate/unrelate."
            ],
            args: ["roleids", true],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!args.roleids.length) {
                this.setDefaultRequirements();
                ep.reply("Default requirements cleared.");
                return true;
            }

            let targetroleids = this.extractRoleIdsFromCollection(args.roleids);
            let checkroles = targetroleids.slice();
            checkroles = checkroles.map(checkroleid => env.server.roles.fetch(checkroleid));
            Promise.all(checkroles)
                .then(roles => {
                    this.setDefaultRequirements(targetroleids);
                    ep.reply("Default requirements set.");
                })
                .catch(e => {
                    ep.reply("One or more roles not found.");
                });

            return true;
        });
        
      
        return true;
    };
    
    
    // # Module code below this line #
    
    initializeEmojiIndex() {
        if (!this._data.channels) return;
        this._emoji = {};
        for (let channelid in this._data.channels) {
            this._emoji[this._data.channels[channelid].emoji] = channelid;
        }
    }


    //Registered channels

    setChannel(channelid, emoji) {
        if (!channelid || !emoji) return false;
        if (!this._data.channels) {
            this._data.channels = {};
        }
        this._data.channels[channelid] = {
            emoji: emoji
        };
        this._data.save();
        return true;
    }

    unsetChannel(channelid) {
        if (!channelid) return false;
        if (!this._data.channels || !this._data.channels[channelid]) return true;
        delete this._data.channels[channelid];
        this._data.save();
        return true;
    }

    getChannel(channelid) {
        if (!channelid) return null;
        return this._data.channels[channelid];
    }

    channelRoleRelateRepresent(channelid, relateid) {
        return this.pushRelation(channelid, "represent", relateid);
    }

    channelRoleRelateRequire(channelid, relateid) {
        return this.pushRelation(channelid, "require", relateid);
    }

    pushRelation(channelid, collection, relateid) {
        if (!channelid || !relateid) return false;
        if (!this._data.channels || !this._data.channels[channelid]) return false;
        if (!this._data.channels[channelid][collection]) {
            this._data.channels[channelid][collection] = [];
        }
        if (!this._data.channels[channelid][collection].includes(relateid)) {
            this._data.channels[channelid][collection].push(relateid);
            this._data.save();
        }
        return true;
    }

    channelRoleUnrelate(channelid, relateid) {
        if (!channelid || !relateid) return false;
        if (!this._data.channels || !this._data.channels[channelid]) return false;
        this.deleteRelation(channelid, "represent", relateid);
        this.deleteRelation(channelid, "require", relateid);
        return true;
    }

    deleteRelation(channelid, collection, relateid) {
        if (!channelid || !relateid) return false;
        if (!this._data.channels || !this._data.channels[channelid]) return false;
        if (!this._data.channels[channelid][collection]) return true;
        if (Array.isArray(relateid)) {
            this._data.channels[channelid][collection] = this._data.channels[channelid][collection].filter(checkid => !relateid.includes(checkid));
        } else {
            if (!this._data.channels[channelid][collection].includes(relateid)) return true;
            this._data.channels[channelid][collection] = this._data.channels[channelid][collection].filter(checkid => checkid != relateid);
        }
        this._data.save();
        return true;
    }

    isChannelRoleSomehowRelated(channelid, relateid) {
        return this.isChannelRoleRelateRepresent(channelid, relateid)
            || this.isChannelRoleRelateRequire(channelid, relateid)
            ;
    }

    isChannelRoleRelateRepresent(channelid, relateid) {
        return this.checkRelation(channelid, "represent", relateid);
    }

    isChannelRoleRelateRequire(channelid, relateid) {
        return this.checkRelation(channelid, "require", relateid);
    }

    checkRelation(channelid, collection, relateid) {
        if (!channelid || !relateid) return false;
        if (!this._data.channels || !this._data.channels[channelid] || !this._data.channels[channelid][collection]) return false;
        return this._data.channels[channelid][collection].includes(relateid);
    }

    getChannelsByRequire(relateid) {
        if (!relateid) return [];
        let result = [];
        for (let channelid in this._data.channels) {
            if (this.isChannelRoleRelateRequire(channelid, relateid)) {
                result.push(channelid);
            }
        }
        return result;
    }

    allChannels() {
        if (!this._data.channels) return [];
        let channels = [];
        for (let channelid in this._data.channels) {
            channels.push(this.denv.server.channels.cache.get(channelid));
        }
        return channels;
    }

    async addMemberToChannel(member, channel, reason) {
        let data = this.getChannel(channel.id);
        if (!data) throw {error: "Channel not found."};

        await channel.updateOverwrite(member.id, {VIEW_CHANNEL: true}, reason);
        if (data.represent) {
            await member.roles.add(data.represent, reason);
        }
    }

    async removeMemberFromChannel(member, channel, reason) {
        let data = this.getChannel(channel.id);
        if (!data) throw {error: "Channel not found."};
        
        await channel.updateOverwrite(member.id, {VIEW_CHANNEL: null}, reason);
        if (data.represent) {
            member.roles.remove(data.represent, reason);
        }
    }

    isMemberInChannel(member, channel) {
        if (!member || !channel) return false;
        return channel.members.get(member.id) && channel.permissionOverwrites.get(member.id)?.allow.has("VIEW_CHANNEL");
    }

    hasMemberChannelRequirements(member, channel) {
        let data = this.getChannel(channel?.id);
        if (!member || !data) return false;
        if (!data.require) return true;

        for (let roleid of data.require) {
            if (!member.roles.cache.get(roleid)) {
                return false;
            }
        }

        return true;
    }

    channelURL(channelid) {
        return "https://discord.com/channels/" + this.denv.server.id + "/" + channelid + "/";
    }


    //Embed

    setEmbedMessageData(color, label) {
        if (!label) label = "";
        if (!color) color = "#808080";
        this._data.embed = {
            label: label,
            color: color,
            channel: null,
            message: null
        };
        this._data.save();
        return true;
    }

    setEmbedMessageAttach(channelid, messageid) {
        if (!channelid || !messageid || !this._data.embed) return false;
        this._data.embed.channel = channelid;
        this._data.embed.message = messageid;
        this._data.save();
        return true;
    }

    unsetEmbedMessage() {
        if (!this._data.embed) return true;
        this._data.embed = null;
        this._data.save();
    }

    getEmbedMessage() {
        return this._data.embed;
    }

    isEmbedMessage(message) {
        let data = this.getEmbedMessage();
        return data && message && data.channel == message.channel.id && data.message == message.id;
    }

    channelLabel(channel) {
        return ("" + (channel.messages ? "#" : "") + channel.name + " " + this.param("channelemojis")[channel.type]).trim();
    }

    generateMessageEmbed() {
        let env = this.denv;
        let data = this.getEmbedMessage();

        let embed = new MessageEmbed();

        embed.setTitle(data.label);
        embed.setColor(data.color);

        let channels = this.allChannels();
        let description = channels.map(channel => {
            let channeldata = this.getChannel(channel.id);
            let result = channeldata.emoji + " **" + this.channelLabel(channel) + "**" + (channel.topic ? " " + channel.topic : "");
            if (channeldata.require && channeldata.require.length) {
                result += (" (Req.: " + channeldata.require.map(reqroleid => env.server.roles.cache.get(reqroleid)?.name || reqroleid) + ")");
            }
            return result;
        }).join("\n");

        embed.setDescription(description);

        return embed;
    }

    async setupMessageReactions(message) {
        if (!message || !this._data.embed) return false;
        let channels = this.allChannels();
        if (!channels.length) return;
        return message.reactions.removeAll()
            .then(() => {
                for (let channel of channels) {
                    let channeldata = this.getChannel(channel.id);
                    message.react(channeldata.emoji);
                }
            });
    }

    async updateMessage() {
        let embeddata = this.getEmbedMessage();
        if (!embeddata) return false;
        let channel = this.denv.server.channels.cache.get(embeddata.channel);
        try {
            let message = await channel.messages.fetch(embeddata.message);
            let embed = await this.generateMessageEmbed();
            message.edit(embed);
            this.setupMessageReactions(message);
        } catch (e) {
            return false;
        };
        return true;
    }

    messageURL() {
        let data = this.getEmbedMessage();
        if (data?.channel && data?.message) {
            return "https://discord.com/channels/" + this.denv.server.id + "/" + data.channel + "/" + data.message;
        }
        return null;
    }


    //Other data

    getParent() {
        return this._data.parent;
    }

    setParent(channelid) {
        if (!channelid) return false;
        this._data.parent = channelid;
        this._data.save();
        return true;
    }

    unsetParent() {
        if (this._data.parent) {
            delete this._data.parent;
            this._data.save();
        }
        return true;
    }

    getDefaults() {
        return this._data.defs;
    }

    setDefaultRequirements(roleids) {
        if (!roleids || !roleids.length) roleids = null;
        if (!this._data.defs) this._data.defs = {};
        this._data.defs.require = roleids;
        this._data.save();
        return true;
    }


    //Helpers

    extractRoleId(roleid) {
        if (!roleid) return null;
        if (roleid.match(/^[0-9]+$/)) return roleid;
        let extr = roleid.match(/<@&([0-9]+)>/);
        if (extr) return extr[1];
        return null;
    }

    extractChannelId(channelid) {
        if (!channelid) return null;
        if (channelid.match(/^[0-9]+$/)) return channelid;
        let extr = channelid.match(/<#([0-9]+)>/);
        if (extr) return extr[1];
        return null;
    }

    extractRoleIdsFromCollection(roleids) {
        if (!roleids) return [];
        return roleids.map(roleid => this.extractRoleId(roleid)).filter(checkroleid => !!checkroleid);
    }
    
    emojiFromReaction(reaction) {
        //Returns the string that produces the emoji or emote in the actual message
        if (!reaction || !reaction.emoji.identifier) return null;
        if (reaction.emoji.identifier.indexOf(":") > -1) return "<:" + reaction.emoji.identifier + ">";
        return reaction.emoji.name;
    }

    isValidColor(color) {
        return color && color.match(/^#[a-z0-9]{6}$/i);
    }

    isEmoji(str) {
        return str.match(/^\p{Extended_Pictographic}(\u200d\p{Extended_Pictographic})?$/u);
    }


}


module.exports = ModReactionChannels;

