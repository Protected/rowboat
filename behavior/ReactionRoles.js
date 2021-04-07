/* Module: ReactionRoles -- Assign roles to users based on message reactions, one message per role color. */

const { MessageEmbed } = require('discord.js');

const Module = require('../Module.js');

const PERM_ADMIN = 'administrator';

class ModReactionRoles extends Module {

    get requiredParams() { return [
        "env"
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
        super('ReactionRoles', name);

        this._data = null;
        this._emoji = {};  //Index of registered roles by emoji
    }

    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Initialize

        this._data = this.loadData(undefined, {roles: {}, groups: {}}, {quiet: true});
        this.initializeEmojiIndex();


        //Register callbacks

        let roleDeleteHandler = async (role) => {
            let roledata = this.getRole(role.id);
            if (!roledata) return;

            if (this._emoji[roledata.emoji]) {
                delete this._emoji[roledata.emoji];
            }
            
            this.unsetRole(role.id);

            let group = this.getGroup(role.hexColor);
            if (group) {
                let channel = this.denv.server.channels.cache.get(group.channel);
                let message = await channel.messages.fetch(group.message);
                let embed = await this.generateGroupMessageEmbed(role.hexColor);
                message.edit(embed);
                this.setupGroupReactions(role.hexColor, message);
            }

            for (let roleid in this._data.roles) {
                this.roleUnrelate(roleid, role.id);
            }

        }

        let roleUpdateHandler = async (oldRole, role) => {
            if (oldRole.hexColor == role.hexColor) return;

            let oldGroup = this.getGroup(oldRole.hexColor);
            if (oldGroup && oldGroup.message) {
                let channel = this.denv.server.channels.cache.get(oldGroup.channel);
                let message = await channel.messages.fetch(oldGroup.message);
                let embed = await this.generateGroupMessageEmbed(oldRole.hexColor);
                message.edit(embed);
                this.setupGroupReactions(oldRole.hexColor, message);
            }

            let group = this.getGroup(role.hexColor);
            if (group) {
                let channel = this.denv.server.channels.cache.get(group.channel);
                let message = await channel.messages.fetch(group.message);
                let embed = await this.generateGroupMessageEmbed(role.hexColor);
                message.edit(embed);
                this.setupGroupReactions(role.hexColor, message);
            }

        }

        let channelDeleteHandler = (channel) => {

            this.resetGroupMessagesByChannel(channel.id);

        }

        let messageDeleteHandler = (message) => {
        
            this.resetGroupMessageByMessage(message.id);
            
        };

        let messageReactionAddHandler = async (messageReaction, user) => {
            if (user.id == this.denv.server.me.id) return;

            let color = this.getGroupColorByMessage(messageReaction.message.channel.id, messageReaction.message.id);
            if (!color) return;

            let emoji = this.emojiFromReaction(messageReaction);

            if (this._emoji[emoji]) {
                let role = await this.denv.server.roles.fetch(this._emoji[emoji]);
                let member = this.denv.server.members.cache.get(user.id);
                if (role && member) {

                    let effects;
                    if (member.roles.cache.get(role.id)) {
                        effects = this.resolveRevokeEffects(role.id);
                    } else {
                        effects = this.resolveGrantEffects(role.id, member);
                    }

                    if (Object.keys(effects.add).length) {
                        await member.roles.add(Object.keys(effects.add), "Reacted to " + messageReaction.message.id + " with " + emoji);
                    }
                    if (Object.keys(effects.remove).length) {
                        member.roles.remove(Object.keys(effects.remove), "Reacted to " + messageReaction.message.id + " with " + emoji);
                    }

                }
            }
            
            messageReaction.users.remove(user.id);

        };

        this.denv.on("connected", async () => {

            //Validate roles

            for (let roleid in this._data.roles) {
                let role = await this.denv.server.roles.fetch(roleid);
                if (!role) this.unsetRole(roleid);
            }

            //Validate group messages

            for (let color in this._data.groups) {
                let group = this.getGroup(color);
                if (!group.message) continue;
                let message, channel = this.denv.server.channels.cache.get(group.channel);
                if (channel) message = await channel.messages.fetch(group.message);
                if (!channel || !message) {
                     this.delGroup(color);
                }
            }

            this.denv.client.on("roleDelete", roleDeleteHandler);
            this.denv.client.on("roleUpdate", roleUpdateHandler);
            this.denv.client.on("channelDelete", channelDeleteHandler);
            this.denv.client.on("messageDelete", messageDeleteHandler);
            this.denv.client.on("messageReactionAdd", messageReactionAddHandler);
        });

        
        //Register commands
        
        
        this.mod('Commands').registerRootDetails(this, 'rrole', {
            description: "Manage reaction-based role assignment.",
            details: [
                "Register roles to associate them with an emoji (for reactions) and label. These are used everywhere the role is displayed. Roles can also have relations with other roles.",
                "Register a color group to declare that roles with that color are managed by this module.",
                "Color groups can have an associated message. If so, reactions to that message will toggle roles with the associated emoji (and relations) as appropriate."
            ]
        });


        this.mod('Commands').registerCommand(this, 'rrole set', {
            description: "Registers a role.",
            details: [
                "If a description isn't provided, the role name will be used."
            ],
            args: ["roleid", "emoji", "description", true],
            minArgs: 2,
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
    
            let roleid = this.extractRoleId(args.roleid);

            let emoji = args.emoji;
            if (!emoji) {
                ep.reply("You must specify an emoji to be used in reactions that manipulate this role.");
                return true;
            }

            if (this._emoji[emoji] && this._emoji[emoji] != roleid) {
                ep.reply("This emoji is already in used by another role (" + roleid + ").");
                return true;
            }

            let description = args.description.join(" ");

            env.server.roles.fetch(roleid)
                .then(role => {
                    if (!description) description = role.name;
                    this.setRole(role.id, emoji, description);
                    this._emoji[emoji] = role.id;
                    ep.reply("Ok.");
                })
                .catch (e => {
                    ep.reply("Role not found.");
                })
    
            return true;
        });
    
        this.mod('Commands').registerCommand(this, 'rrole unset', {
            description: "Unregisters a role.",
            args: ["roleid"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
    
            let roleid = this.extractRoleId(args.roleid);

            let roledata = this.getRole(roleid);
            if (this._emoji[roledata.emoji]) {
                delete this._emoji[roledata.emoji];
            }

            this.unsetRole(roleid);
            ep.reply("Ok.");
    
            return true;
        });

        this.mod('Commands').registerCommand(this, 'rrole checkcolor', {
            description: "Retrieve the current color of a role.",
            args: ["roleid"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let roleid = this.extractRoleId(args.roleid);

            env.server.roles.fetch(roleid)
                .then(role => {
                    ep.reply(role.name + ": " + role.hexColor);
                })
                .catch (e => {
                    ep.reply("Role not found.");
                })

            return true;
        });


        let relateMultipleRoles = (env, args, ep, relateMethod) => {
            let roleid = this.extractRoleId(args.roleid);
            let targetroleids = this.extractRoleIdsFromCollection(args.targetroleid);
            let checkroles = targetroleids.slice();
            checkroles.unshift(roleid);
            checkroles = checkroles.map(checkroleid => env.server.roles.fetch(checkroleid));
            Promise.all(checkroles)
                .then(roles => {
                    for (let relateid of targetroleids) {
                        if (this.isRoleSomehowRelated(roleid, relateid)) {
                            ep.reply(roleid + " already has a prior relationship with " + relateid + ".");
                            continue;
                        }
                        if (relateMethod.call(this, roleid, relateid)) {
                            ep.reply("Relationship established between " + roleid + " and " + relateid + ".");
                        } else {
                            ep.reply("Could not establish relationship between " + roleid + " and " + relateid + ".");
                        }
                    }
                })
                .catch(e => {
                    ep.reply("One or more roles not found.");
                });
            return true;
        }

        this.mod('Commands').registerCommand(this, 'rrole relate add', {
            description: "When the role is granted, the target role is also granted.",
            details: [
                "Losing the role does not result in the loss of the target role."
            ],
            args: ["roleid", "targetroleid", true],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => relateMultipleRoles(env, args, ep, this.roleRelateAdd));

        this.mod('Commands').registerCommand(this, 'rrole relate remove', {
            description: "When the role is granted, the target role is removed.",
            details: [
                "Losing the role does not result in the recovery of the target role."
            ],
            args: ["roleid", "targetroleid", true],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => relateMultipleRoles(env, args, ep, this.roleRelateRemove));

        this.mod('Commands').registerCommand(this, 'rrole relate require', {
            description: "The role can only be granted if the user has the target role.",
            details: [
                "The loss of the target role results in the loss of the role."
            ],
            args: ["roleid", "targetroleid", true],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => relateMultipleRoles(env, args, ep, this.roleRelateRequire));

        this.mod('Commands').registerCommand(this, 'rrole unrelate', {
            description: "Removes the relationship between the role and the target role (if any).",
            args: ["roleid", "targetroleid", true],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let roleid = this.extractRoleId(args.roleid);
            let targetroleids = this.extractRoleIdsFromCollection(args.targetroleid);

            if (this.roleUnrelate(roleid, targetroleids)) {
                ep.reply("Ok."); 
            } else {
                ep.reply("Can't unrelate a role from itself!");
            }

            return true;
        });


        let addCollectionToEmbed = async (env, embed, roledata, collection, label) => {
            let roles = roledata[collection];
            if (!roles || !roles.length) return;
            try {
                let checkroles = roles.map(relationroleid => env.server.roles.fetch(relationroleid));
                let checkedroles = await Promise.all(checkroles)
                roles = checkedroles.map(role => role.name);
            } catch (e) {}
            embed.addField(label, roles.join(", "));
        };
        
        this.mod('Commands').registerCommand(this, 'rrole info', {
            description: "Shows information associated with a registered role.",
            args: ["roleid"],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let roleid = this.extractRoleId(args.roleid);
            let roledata = this.getRole(roleid);
            if (!roledata) {
                ep.reply("Role not known.");
                return true;
            }

            let role = await env.server.roles.fetch(roleid);

            let embed = new MessageEmbed();

            embed.setTitle(role.name);
            embed.setColor(role.color);
            embed.setDescription(roledata.emoji + " " + roledata.desc);

            await addCollectionToEmbed(env, embed, roledata, "require", "Requires:");
            await addCollectionToEmbed(env, embed, roledata, "add", "Grants:");
            await addCollectionToEmbed(env, embed, roledata, "remove", "Revokes:");

            ep.reply(embed);

            return true;
        });


        this.mod('Commands').registerCommand(this, 'rrole group add', {
            description: "Registers a group of roles with a certain color.",
            args: ["color", "label", true],
            minArgs: 1,
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
    
            let color = args.color;
            if (!this.isValidColor(color)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }
            color = color.toLowerCase();

            let label = args.label.join(" ");

            this.addGroup(color, label, args.joiner);
            ep.reply("Ok.");
    
            return true;
        });
    
        this.mod('Commands').registerCommand(this, 'rrole group remove', {
            description: "Unregisters the group of roles with a certain color.",
            args: ["color"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
    
            let color = args.color;
            if (!this.isValidColor(color)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }
            color = color.toLowerCase();

            this.delGroup(color);
            ep.reply("Ok.");
    
            return true;
        });

        this.mod('Commands').registerCommand(this, 'rrole group list', {
            description: "Lists all the registered color groups.",
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this._data.groups || !Object.keys(this._data.groups).length) {
                ep.reply("There are no groups.");
                return true;
            }

            let results = [];
            for (let color in this._data.groups) {
                let group = this.getGroup(color);
                let url = this.groupMessageURL(color);
                results.push(color + " " + group.label + (url ? " (" + url + ")" : ""));
            }

            ep.reply(results.join("\n"));

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rrole group roles', {
            description: "Lists all the roles currently in a group.",
            args: ["color"],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let color = args.color;
            if (!this.isValidColor(color)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }
            color = color.toLowerCase();
            let group = this.getGroup(color);
            if (!group) {
                ep.reply("There is no group with this color.");
                return true;
            }

            let embed = new MessageEmbed();

            embed.setTitle(group.label);
            embed.setColor(color);

            let roles = await this.rolesByColor(color);
            let description = roles.map(role => {
                let roledata = this.getRole(role.id);
                return roledata.emoji + " " + role.name + " (" + role.id + ")" + (role.name != roledata.desc ? ": " + roledata.desc : "");
            }).join("\n");

            if (group.channel && group.message) {
                description += "\n\n[Go to message](https://discord.com/channels/" + env.server.id + "/" + group.channel + "/" + group.message + ")"; 
            }

            embed.setDescription(description);

            ep.reply(embed);

            return true;
        });


        this.mod('Commands').registerCommand(this, 'rrole message create', {
            description: "Creates a new message for the assignment of roles of this color in the specified channel.",
            args: ["color", "targetchannelid"],
            minArgs: 1,
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let targetchannelid = args.targetchannelid || channelid;

            let color = args.color;
            if (!this.isValidColor(color)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }
            color = color.toLowerCase();

            let group = this.getGroup(color);
            if (!group) {
                ep.reply("There is no group with this color.");
                return true;
            }

            if (group.message) {
                ep.reply("This group already has a message.");
                return true;
            }

            let channel = env.server.channels.cache.get(targetchannelid);
            if (!channel || channel.type != "text") {
                ep.reply("Text channel not found.");
                return true;
            }

            let embed = await this.generateGroupMessageEmbed(color);
            let message = await channel.send(embed);
            this.setGroupMessage(color, channel.id, message.id);
            this.setupGroupReactions(color, message);
            ep.reply("Ok.");

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rrole message assign', {
            description: "Uses an existing message for the assignment of roles of this color.",
            args: ["color", "messageid", "targetchannelid"],
            minArgs: 2,
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let targetchannelid = args.targetchannelid || channelid;

            let color = args.color;
            if (!this.isValidColor(color)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }
            color = color.toLowerCase();

            let group = this.getGroup(color);
            if (!group) {
                ep.reply("There is no group with this color.");
                return true;
            }

            if (group.message) {
                ep.reply("This group already has a message.");
                return true;
            }

            let channel = env.server.channels.cache.get(targetchannelid);
            if (!channel || channel.type != "text") {
                ep.reply("Text channel not found.");
                return true;
            }

            try {
                let message = await channel.messages.fetch(args.messageid);
                let embed = await this.generateGroupMessageEmbed(color);
                message.edit(embed);
                this.setGroupMessage(color, channel.id, args.messageid);
                this.setupGroupReactions(color, message);
                ep.reply("Ok.");
            } catch (e) {
                ep.reply("Message not found.");
            };

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rrole message update', {
            description: "Updates the assigned message for the given color.",
            args: ["color"],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let color = args.color;
            if (!this.isValidColor(color)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }
            color = color.toLowerCase();

            let group = this.getGroup(color);
            if (!group) {
                ep.reply("There is no group with this color.");
                return true;
            }

            if (!group.message) {
                ep.reply("This group doesn't have a message.");
                return true;
            }

            let channel = env.server.channels.cache.get(group.channel);

            try {
                let message = await channel.messages.fetch(group.message);
                let embed = await this.generateGroupMessageEmbed(color);
                message.edit(embed);
                this.setupGroupReactions(color, message);
                ep.reply("Ok.");
            } catch (e) {
                ep.reply("Message not found.");
            };

            return true;
        });


        this.mod('Commands').registerCommand(this, 'rrole message unassign', {
            description: "Detaches the message (if any) assigned to a group of roles.",
            details: [
                "The message will not be deleted automatically."
            ],
            args: ["color"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let color = args.color;
            if (!this.isValidColor(color)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }
            color = color.toLowerCase();

            let group = this.getGroup(color);
            if (!group) {
                ep.reply("There is no group with this color.");
                return true;
            }            

            this.resetGroupMessage(color);
            ep.reply("Ok.");

            return true;
        });
    
      
        return true;
    };
    
    
    // # Module code below this line #
    
    initializeEmojiIndex() {
        if (!this._data.roles) return;
        this._emoji = {};
        for (let roleid in this._data.roles) {
            this._emoji[this._data.roles[roleid].emoji] = roleid;
        }
    }


    //Registered roles

    setRole(roleid, emoji, description) {
        if (!roleid || !emoji || !description) return false;
        if (!this._data.roles) {
            this._data.roles = {};
        }
        this._data.roles[roleid] = {
            emoji: emoji,
            desc: description
        };
        this._data.save();
        return true;
    }

    unsetRole(roleid) {
        if (!roleid) return false;
        if (!this._data.roles || !this._data.roles[roleid]) return true;
        delete this._data.roles[roleid];
        this._data.save();
        return true;
    }

    getRole(roleid) {
        if (!roleid) return null;
        return this._data.roles[roleid]
    }

    roleRelateAdd(roleid, relateid) {
        return this.pushRelation(roleid, "add", relateid);
    }

    roleRelateRemove(roleid, relateid) {
        return this.pushRelation(roleid, "remove", relateid);
    }

    roleRelateRequire(roleid, relateid) {
        return this.pushRelation(roleid, "require", relateid);
    }

    pushRelation(roleid, collection, relateid) {
        if (!roleid || !relateid || roleid == relateid) return false;
        if (!this._data.roles || !this._data.roles[roleid]) return false;
        if (!this._data.roles[roleid][collection]) {
            this._data.roles[roleid][collection] = [];
        }
        if (!this._data.roles[roleid][collection].includes(relateid)) {
            this._data.roles[roleid][collection].push(relateid);
            this._data.save();
        }
        return true;
    }

    roleUnrelate(roleid, relateid) {
        if (!roleid || !relateid) return false;
        if (Array.isArray(relateid) && relateid.includes(roleid) || !Array.isArray(relateid) && roleid == relateid) return false;
        if (!this._data.roles || !this._data.roles[roleid]) return false;
        this.deleteRelation(roleid, "add", relateid);
        this.deleteRelation(roleid, "remove", relateid);
        this.deleteRelation(roleid, "require", relateid);
        return true;
    }

    deleteRelation(roleid, collection, relateid) {
        if (!roleid || !relateid) return false;
        if (Array.isArray(relateid) && relateid.includes(roleid) || !Array.isArray(relateid) && roleid == relateid) return false;
        if (!this._data.roles || !this._data.roles[roleid]) return false;
        if (!this._data.roles[roleid][collection]) return true;
        if (Array.isArray(relateid)) {
            this._data.roles[roleid][collection] = this._data.roles[roleid][collection].filter(checkid => !relateid.includes(checkid));
        } else {
            if (!this._data.roles[roleid][collection].includes(relateid)) return true;
            this._data.roles[roleid][collection] = this._data.roles[roleid][collection].filter(checkid => checkid != relateid);
        }
        this._data.save();
        return true;
    }

    isRoleSomehowRelated(roleid, relateid) {
        return this.isRoleRelateAdd(roleid, relateid)
            || this.isRoleRelateRemove(roleid, relateid)
            || this.isRoleRelateRequire(roleid, relateid)
            ;
    }

    isRoleRelateAdd(roleid, relateid) {
        return this.checkRelation(roleid, "add", relateid);
    }

    isRoleRelateRemove(roleid, relateid) {
        return this.checkRelation(roleid, "remove", relateid);
    }

    isRoleRelateRequire(roleid, relateid) {
        return this.checkRelation(roleid, "require", relateid);
    }

    checkRelation(roleid, collection, relateid) {
        if (!roleid || !relateid || roleid == relateid) return false;
        if (!this._data.roles || !this._data.roles[roleid] || !this._data.roles[roleid][collection]) return false;
        return this._data.roles[roleid][collection].includes(relateid);
    }

    getRolesByRequire(relateid) {
        if (!relateid) return [];
        let result = [];
        for (let roleid in this._data.roles) {
            if (this.isRoleRelateRequire(roleid, relateid)) {
                result.push(roleid);
            }
        }
        return result;
    }

    async rolesByColor(color) {  //throws
        if (!color || !this.isValidColor(color) || !this._data.roles) return [];
        let rolepromises = [];
        for (let roleid in this._data.roles) {
            rolepromises.push(this.denv.server.roles.fetch(roleid));
        }
        let roles = await Promise.all(rolepromises);
        return roles.filter(role => role.hexColor == color);
    }

    resolveGrantEffects(roleid, member) {
        //Add role and add and remove its add/remove relations trees, except for adds for which not all requires are present
        let result = {
            add: {},
            remove: {}
        };
        if (!member || !roleid) return result;
        let stack = [roleid];  //Roles to be added
        let missingreq =  {};
        let processed = {};
        let processing = null;
        while (processing = stack.pop()) {
            let roledata = this.getRole(processing);
            if (!roledata) continue;

            //Validate requirements
            let allowed = true;
            if (roledata.require && roledata.require.length) {
                for (let reqroleid of roledata.require) {
                    if (!result.add[reqroleid] && !member.roles.cache.get(reqroleid)) {
                        missingreq[processing] = reqroleid;
                        allowed = false;
                        break;
                    }
                }
            }

            if (!allowed) continue;

            //Add to result. Override removal if present.
            result.add[processing] = true;  
            if (result.remove[processing]) {
                delete result.remove[processing];
            }

            //Requirement is now present for previously rejected role; retry
            for (let blockedroleid in missingreq) {
                if (missingreq[blockroleid] == processing) {
                    delete missingreq[blockroleid];
                    stack.push(blockroleid);
                }
            }

            //Removes for accepted add; these don't chain so just put them in result
            if (roledata.remove && roledata.remove.length) {
                for (let relateid of roledata.remove) {
                    if (!result.add[relateid]) {
                        result.remove[relateid] = true;
                    }
                }
            }

            //Adds for accepted add; put in stack
            if (roledata.add && roledata.add.length) {
                for (let relateid of roledata.add) {
                    if (!processed[relateid]) {
                        stack.push(relateid);
                    }
                }
            }

            processed[processing] = true;
        }
        return result;
    }

    resolveRevokeEffects(roleid) {
        //Remove role and its dependent tree
        let result = {
            add: {},  //Always empty
            remove: {}
        };
        if (!roleid) return result;
        let stack = [roleid];  //Roles to be removed
        let processed = {};
        let processing = null;
        while (processing = stack.pop()) {
            let roledata = this.getRole(processing);
            if (!roledata) continue;

            for (let deproleid of this.getRolesByRequire(processing)) {
                if (!processed[deproleid]) {
                    stack.push(deproleid);
                }
            }

            result.remove[processing] = true;
            processed[processing] = true;
        }
        return result;
    }


    //Color groups

    isValidColor(color) {
        return color && color.match(/^#[a-z0-9]{6}$/i);
    }

    addGroup(color, label) {
        if (!color) return false;
        if (!label) label = "";
        if (!this._data.groups) {
            this._data.groups = {};
        }
        this._data.groups[color] = {
            label: label,
            channel: null,
            message: null
        };
        this._data.save();
        return true;
    }

    delGroup(color) {
        if (!color) return false;
        if (!this._data.groups || !this._data.groups[color]) return true;
        delete this._data.groups[color];
        this._data.save();
        return true;
    }

    getGroup(color) {
        if (!color) return null;
        return this._data.groups[color];
    }

    getGroupColorByMessage(channelid, messageid) {
        if (!this._data.groups || !channelid || !messageid) return null;
        for (let color in this._data.groups) {
            if (this._data.groups[color].channel == channelid && this._data.groups[color].message == messageid) {
                return color;
            }
        }
        return null;
    }

    setGroupMessage(color, channelid, messageid) {
        if (!color || !this._data.groups || !this._data.groups[color]) return false;
        this._data.groups[color].channel = channelid;
        this._data.groups[color].message = messageid;
        this._data.save();
        return true;
    }

    resetGroupMessage(color) {
        if (!color || !this._data.groups || !this._data.groups[color]) return false;
        this._data.groups[color].channel = null;
        this._data.groups[color].message = null;
        this._data.save();
        return true;
    }

    resetGroupMessageByMessage(messageid) {
        if (!messageid || !this._data.groups) return false;
        for (let color in this._data.groups) {
            if (this._data.groups[color].message && this._data.groups[color].message == messageid) {
                return this.resetGroupMessage(color);
            }
        }
        return false;
    }

    resetGroupMessagesByChannel(channelid) {
        if (!channelid || !this._data.groups) return 0;
        let count = 0;
        for (let color in this._data.groups) {
            if (this._data.groups[color].channel && this._data.groups[color].channel == channelid) {
                this._data.groups[color].channel = null;
                this._data.groups[color].message = null;
                count += 1;
            }
        }
        this._data.save();
        return count;
    }

    async generateGroupMessageEmbed(color) {
        let env = this.denv;
        let group = this.getGroup(color);

        let embed = new MessageEmbed();

        embed.setTitle(group.label);
        embed.setColor(color);

        let roles = await this.rolesByColor(color);
        let description = roles.map(role => {
            let roledata = this.getRole(role.id);
            let result = roledata.emoji + " " + roledata.desc;
            if (roledata.require && roledata.require.length) {
                result += (" (Req.: " + roledata.require.map(reqroleid => env.server.roles.cache.get(reqroleid)?.name || reqroleid) + ")");
            }
            return result;
        }).join("\n");

        embed.setDescription(description);

        return embed;
    }

    async setupGroupReactions(color, message) {
        if (!color || !message || !this._data.groups || !this._data.groups[color]) return false;
        let roles = await this.rolesByColor(color);
        if (!roles.length) return;
        return message.reactions.removeAll()
            .then(() => {
                for (let role of roles) {
                    let roledata = this.getRole(role.id);
                    message.react(roledata.emoji);
                }
            });
    }

    groupMessageURL(color) {
        let group = this.getGroup(color);
        if (group.channel && group.message) {
            return "https://discord.com/channels/" + this.denv.server.id + "/" + group.channel + "/" + group.message;
        }
        return null;
    }



    //Helpers

    extractRoleId(roleid) {
        if (!roleid) return null;
        if (roleid.match(/^[0-9]+$/)) return roleid;
        let extr = roleid.match(/<@&([0-9]+)>/);
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


}


module.exports = ModReactionRoles;

