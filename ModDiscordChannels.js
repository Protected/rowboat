/* Module: DiscordChannels -- Advanced behavior for Discord channels. */

const Module = require('./Module.js');
const moment = require('moment');

const PERM_ADMIN = "administrator";

class ModDiscordChannels extends Module {

    get optionalParams() { return [
        'datafile',
        'tempchannels',         //Enable/disable temporary channels
        'publictempchannels',   //Enable/disable public temporary channels (still requires tempchannels to enable)
        'textcategory',         //Parent category ID for temporary text channels
        'voicecategory',        //Parent category ID for temporary voice channels
        'opscolor',             //Color for the operators roles in temporary channels [R, G, B]
        'autodeltext',          //Seconds of inactivity until automatic deletion of temporary text channels (null disables)
        'autodelvoice',         //Seconds of inactivity until automatic deletion of temporary voice channels (null disables)
        'defaulttopublic'       //Newly created channels default to public instead of private
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Users',
        'Commands'
    ]; }

    constructor(name) {
        super('DiscordChannels', name);
        
        this._params['tempchannels'] = false;
        this._params['publictempchannels'] = false;
        this._params['datafile'] = null;
        this._params['textcategory'] = null;
        this._params['voicecategory'] = null;
        this._params['opscolor'] = [0, 0, 0];
        this._params['autodeltext'] = null;
        this._params['autodelvoice'] = 900;
        this._params['defaulttopublic'] = false;

        //{ENV: {CHANNELID: {env, channelid, type, creatorid, accessroleid, opsroleid, key, temp, closed, public, lastused}, ...}, ...}
        this._data = {};

        //IDs of objects being deliberately deleted.
        this._deleting = {};

        //Automatically delete unused temporary channels
        this._autodeltimer = null;
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        this._data = this.loadData(null, {}, {quiet: true});
        if (this._data === false) return false;


        let testIsModerator = (envname, userid, channelid) =>
            this.mod('Users').testPermissions(envname, userid, channelid, [PERM_ADMIN]);


        this._autodeltimer = setInterval(() => {
            for (let name in opt.envs) {
                let env = opt.envs[name];
                if (env.envName != "Discord") continue;
                for (let item of this.listAttachedChannels(env)) {
                    if (!this.isChannelTemporary(env, item.channelid)) continue;
                    let data = this.getChannelData(env, item.channelid);
                    if (data.type == "text" && this.param("autodeltext")
                            && this.checkSecsSinceLastUsed(env, item.channelid) > this.param("autodeltext")
                            || data.type == "voice" && this.param("autodelvoice")
                            && this.checkSecsSinceLastUsed(env, item.channelid) > this.param("autodelvoice")) {

                        if (data.type == "voice") {
                            let channel = env.server.channels.get(item.channelid);
                            if (channel && channel.members.array().length) continue;
                        }
                        
                        this.destroyTempChannel(env, item.channelid)
                            .then(() => {
                                this.log("{" + env.name + "} [" + item.channelid + " " + data.name + "] Temporary channel destroyed for inactivity.");
                            })
                            .catch((problem) => {
                                this.log("error", "{" + env.name + "} [" + item.channelid + " " + data.name + "] Temporary channel could not be destroyed for inactivity: " + problem);
                            });

                    }
                }
            }
        }, 60000);


        //Register callbacks


        let findEnvFromServer = (guild) => {
            for (let name in opt.envs) {
                if (opt.envs[name].server.id == guild.id) {
                    return opt.envs[name];
                }
            }
            return null;
        };


        let guildMemberRemoveHandler = (member) => {
            //A server member is gone: If he owned any channels, hand them over to someone else or destroy them
            let env = findEnvFromServer(member.guild);
            if (!env) return;
            for (let item of this.listAttachedChannels(env)) {
                if (!this.isUserChannelOwner(env, item.channelid, member.id)) continue;
                let candidates = this.listChannelOps(env, item.channelid).filter((checkuserid) => checkuserid != member.id);
                if (!candidates.length) {
                    if (this.isChannelTemporary(env, item.channelid)) {
                        this.destroyTempChannel(env, channelid)
                            .then(() => {
                                this.log("{" + env.name + "} [" + item.channelid + "] Temporary channel destroyed when owner departed server without successors.");
                            })
                            .catch((problem) => {
                                this.log('error', "{" + env.name + "} [" + item.channelid + "] Failed to handle temporary channel destruction when owner departed server without successors (module state may have become corrupted!) Reason: " + problem);
                            });
                    } else {
                        this.channelDetach(env, item.channelid)
                            .then(() => {
                                this.log("{" + env.name + "} [" + item.channelid + "] Channel detached when owner departed server without successors.");
                            })
                            .catch((problem) => {
                                this.log('error', "{" + env.name + "} [" + item.channelid + "] Failed to handle permanent channel detachment when owner departed server without successors (module state may have become corrupted!) Reason: " + problem);
                            });
                    }
                } else {
                    this._data[env.name][item.channelid].creatorid = candidates[0];
                    this._data.save();
                    
                }
            }
        };


        let guildMemberUpdateHandler = (oldmember, newmember) => {
            //A server member's roles may have changed: Prevent channel owners from losing ops
            let env = findEnvFromServer(oldmember.guild);
            if (!env) return;

            let promises = [];
            for (let item of this.listAttachedChannels(env)) {
                if (!this.isUserChannelOwner(env, item.channelid, oldmember.id)) continue;
                let data = this.getChannelData(env, item.channelid);
                if (oldmember.roles.get(data.opsroleid) && !newmember.roles.get(data.opsroleid)) {
                    let role = env.server.roles.get(data.opsroleid);
                    if (!role) continue;
                    promises.push(newmember.addRole(role, "Restoring opsrole to attached channel owner"));
                }
            }

            Promise.all(promises)
                .then(() => {
                    this.log("{" + env.name + "} Restored " + promises.length + " externally removed ops role(s).");
                })
                .catch((problem) => {
                    this.log('error', "{" + env.name + "} Failed to restore " + promises.length + " externally removed ops role(s) (module state may have become corrupted!) Reason: " + problem);
                });
        };
        

        let roleDeleteHandler = (role) => {
            //A role was deleted: If it was the ops role of an attached channel, create a new ops role. If it was an access role, clear it.
            let env = findEnvFromServer(role.guild);
            if (!env) return;

            let promises = [], changes = false;
            for (let item of this.listAttachedChannels(env)) {
                if (this._deleting[item.channelid]) continue;
                let data = this._data[env.name][item.channelid];
                if (data.accessroleid == role.id) {
                    data.accessroleid = null;
                    this.log("{" + env.name + "} [" + item.channelid + " " + data.name + "] Access role destroyed.");
                    changes = true;
                }
                if (data.opsroleid == role.id) {
                    let channel = env.server.channels.get(item.channelid);
                    if (channel) {
                        promises.push(
                            this.doCreateOpsRole(env, item.name, channel.type)
                                .then((opsrole) => {
                                    data.opsroleid = opsrole.id;
                                    return this.doAssignRoleToUser(env, opsrole.id, data.creatorid, "Promoting channel owner to operator");
                                })
                                .then(() => { this.log("{" + env.name + "} [" + channel.id + "] Handled associated role removal.") })
                                .catch((problem) => { this.log('error', "{" + env.name + "} [" + channel.id + "] Failed to handle role removal (module state may have become corrupted!) Reason: " + problem); })
                        );
                    } else {
                        promises.push(this.doDetachChannel(env, item.channelid));
                    }
                }
            }

            if (promises.length) {
                Promise.all(promises)
                    .then(() => {
                        this._data.save();
                    })
                    .catch((problem) => {
                        this.log('error', "{" + env.name + "} Failed to handle role removal (module state may have become corrupted!) Reason: " + problem);
                    });
            } else if (changes) {
                this._data.save();
            }
        };


        let channelDeleteHandler = (channel) => {
            //A channel was deleted: If it was attached, clear associated data.
            let env = findEnvFromServer(channel.guild);
            if (!env || !this.isChannelAttached(env, channel.id) || this._deleting[channel.id]) return;

            this._deleting[channelid] = true;
            this.doDestroyOpsRole(env, this._data[env.name][channel.id].opsroleid)
                .then(() => this.doDetachChannel(env, channel.id))
                .then(() => {
                    this.log("{" + env.name + "} [" + channel.id + "] Cleanup after channel destruction.");
                    delete this._deleting[channelid];
                })
                .catch((problem) => {
                    this.log('error', "{" + env.name + "} [" + channel.id + "] Failed cleanup after channel destruction (module state may have become corrupted!) Reason: " + problem);
                    delete this._deleting[channelid];
                });
        };


        let voiceStateUpdateHandler = (oldmember, newmember) => {
            if (!newmember.voiceChannelID) return;
            let env = findEnvFromServer(oldmember.guild);
            if (!env || newmember.deaf) return;
            if (!this.isChannelAttached(env, newmember.voiceChannelID)) return;
            this.doTouchChannel(env, newmember.voiceChannelID);
        };


        let guildMemberSpeakingHandler = (member, speaking) => {
            if (!speaking || !member.voiceChannelID) return;
            let env = findEnvFromServer(member.guild);
            if (!env) return;
            if (!this.isChannelAttached(env, member.voiceChannelID)) return;
            this.doTouchChannel(env, member.voiceChannelID);
        }


        let messageHandler = (env, type, message, authorid, channelid, messageObject) => {
            if (type != "regular") return;
            if (!this.isChannelAttached(env, channelid)) return;
            this.doTouchChannel(env, channelid);
        }


        for (let name in opt.envs) {
            let env = opt.envs[name];
            if (env.envName != "Discord") continue;

            env.on("connected", () => {
                env.client.on("guildMemberRemove", guildMemberRemoveHandler);
                env.client.on("guildMemberUpdate", guildMemberUpdateHandler);
                env.client.on("roleDelete", roleDeleteHandler);
                env.client.on("channelDelete", channelDeleteHandler);
                env.client.on("voiceStateUpdate", voiceStateUpdateHandler);
                env.client.on("guildMemberSpeaking", guildMemberSpeakingHandler);
                env.on("message", messageHandler);
            });
        }


        //Register commands
        
        this.mod('Commands').registerRootDetails(this, 'chan', {description: 'Control channels with advanced behavior.'});


        this.mod('Commands').registerCommand(this, 'chan attach', {
            description: "Attach an existing (non-temporary) channel.",
            details: ["You can provide the ID of an existing role to be used to regulate access. The role won't be modified."],
            args: ["channelid", "roleid"],
            minArgs: 0,
            environments: ["Discord"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid = args.channelid;
            if (!targetchannelid || targetchannelid == "-") {
                targetchannelid = channelid;
            }

            if (!this.checkEnvUsable(env)) {
                ep.reply("I can't manage channels or roles in this environment.");
                return true;
            }

            if (this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is already attached.");
                return true;
            }

            if (!env.server.channels.get(targetchannelid)) {
                ep.reply("A channel with this ID could not be found.");
                return true;
            }

            if (args.roleid && !env.server.roles.get(args.roleid)) {
                ep.reply("A role with this ID could not be found.");
                return true;
            }

            this.channelAttach(env, targetchannelid, args.roleid, userid)
                .then((channeldata) => {
                    if (!channeldata.public) {
                        return this.userJoinChannel(env, targetchannelid, userid);
                    }
                 })
                .then(() => this.channelOp(env, targetchannelid, userid))
                .then(() => {
                    ep.reply("Channel attached.");
                    this.log("{" + env.name + "} [" + targetchannelid + "] Attached by " + userid);
                })
                .catch((problem) => {
                    ep.reply("Unable to attach channel.");
                    this.log("warn", "{" + env.name + "} [" + targetchannelid + "] Error attaching channel: " + problem);
                })
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan detach', {
            description: "Detach any attached channel.",
            details: ["Once you detach a channel, advanced behavior commands will no longer work with it until it's reattached."],
            args: ["channelid"],
            minArgs: 0,
            environments: ["Discord"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid = args.channelid;
            if (!targetchannelid || targetchannelid == "-") {
                targetchannelid = channelid;
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            this.channelDetach(env, targetchannelid)
                .then(() => {
                    ep.reply("Channel detached.");
                    this.log("{" + env.name + "} [" + targetchannelid + "] Detached by " + userid);
                })
                .catch((problem) => {
                    ep.reply("Unable to detach channel.");
                    this.log("warn", "{" + env.name + "} [" + targetchannelid + "] Error detatching channel: " + problem);
                })
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan op', {
            description: "Turn a user into a channel operator.",
            details: ["Operators can create new operators, invite or kick users and change the channel key."],
            args: ["channel", "user"],
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOp(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("You are not an operator.");
                return true;
            }

            let targetuserid = env.displayNameToId(args.user) || args.user;
            if (!env.server.members.get(targetuserid)) {
                ep.reply("User not found.");
                return true;
            }

            this.channelOp(env, targetchannelid, targetuserid)
                .then(() => {
                    ep.reply("User successfully promoted.");
                    this.log("{" + env.name + "} [" + targetchannelid + "] User " + targetuserid + " opped by " + userid);
                })
                .catch((problem) => {
                    ep.reply("Unable to promote user.");
                    this.log("warn", "{" + env.name + "} [" + targetchannelid + "] User " + targetuserid + " could not be opped by " + userid + ": " + problem);
                });
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan deop', {
            description: "Revoke operator permissions from a user.",
            args: ["channel", "user"],
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            let ammoderator = testIsModerator(env.name, userid, targetchannelid);

            if (!this.isUserChannelOp(env, targetchannelid, userid) && !ammoderator) {
                ep.reply("You are not an operator.");
                return true;
            }

            let targetuserid = env.displayNameToId(args.user) || args.user;
            if (!env.server.members.get(targetuserid)) {
                ep.reply("User not found.");
                return true;
            }
            
            let replacementid = null;
            if (this.isUserChannelOwner(env, targetchannelid, targetuserid)) {
                if (ammoderator || userid == targetuserid) {
                    //Creator replacement
                    let candidates = this.listChannelOps(env, targetchannelid).filter((checkuserid) => checkuserid != targetuserid);
                    if (!candidates.length) {
                        ep.reply("You can't demote the channel owner because there is no replacement candidate. Promote someone else first.");
                        return true;
                    } else {
                        replacementid = candidates[0];
                    }
                } else {
                    ep.reply("You can't demote the channel owner.");
                    return true;
                }
            }

            this.channelDeop(env, targetchannelid, targetuserid)
                .then(() => {
                    ep.reply("User successfully demoted.");
                    this.log("{" + env.name + "} [" + targetchannelid + "] User " + targetuserid + " deopped by " + userid);
                    if (replacementid) {
                        this._data[env.name][targetchannelid].creatorid = replacementid;
                        this._data.save();
                        ep.reply(env.idToDisplayName(replacementid) + " is now the channel owner.");
                        this.log("{" + env.name + "} [" + targetchannelid + "] User " + replacementid + " is now the channel owner.");
                    }
                })
                .catch((problem) => {
                    ep.reply("Unable to demote user.");
                    this.log("warn", "{" + env.name + "} [" + targetchannelid + "] User " + targetuserid + " could not be deopped by " + userid + ": " + problem);
                });
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan set key', {
            description: "Set or clear the channel key.",
            details: [
                "The channel key, if set, is required for joining the channel.",
                "This command, as well as join CHANNEL KEY, can only be used via private message."
            ],
            args: ["channel", "key"],
            minArgs: 0,
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOp(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("You are not an operator.");
                return true;
            }

            if (this.isChannelPublic(env, targetchannelid) && args.key) {
                ep.reply("This channel is public - users can't be excluded! Try setting it to private.");
                return true;
            }

            if (type != "private" && targetchannelid != channelid && args.key) {
                if (this.isChannelOpen(env, targetchannelid)) {
                    ep.reply("You can't set the channel key in public! Channel automatically closed. Set the key privately and reopen it using chan open.");
                    this.channelClose(env, targetchannelid);
                    this.log("{" + env.name + "} [" + targetchannelid + "] Channel closed due to public key set attempt.");
                } else {
                    ep.reply("You can't set the channel key in public! Try again in private, with a different key.");
                }
                return true;
            }

            this.channelSetKey(env, targetchannelid, args.key);
            if (args.key) {
                ep.reply("Channel key successfully set.");
                this.log("{" + env.name + "} [" + targetchannelid + "] Key successfully set.");
            } else {
                ep.reply("Channel key successfully cleared.");
                this.log("{" + env.name + "} [" + targetchannelid + "] Key successfully cleared.");
            }
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan set public', {
            description: "Change a channel from private to public.",
            details: [
                "Public channels are always visible to everyone.",
                "The commands (v)join, part, kick, invite and chan clear users will no longer work on them."
            ],
            args: ["channel"],
            minArgs: 0,
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOp(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("You are not an operator.");
                return true;
            }

            if (this.isChannelPublic(env, targetchannelid)) {
                ep.reply("The channel was already public.");
                return true;
            }

            this.channelSetPublic(env, targetchannelid)
                .then(() => {
                    ep.reply("The channel is now public.");
                    this.log("{" + env.name + "} [" + targetchannelid + "] Channel set to public.");
                })
                .catch((problem) => {
                    ep.reply("Unable to change channel from private to public.");
                    this.log("warn", "{" + env.name + "} [" + targetchannelid + "] Unable to change channel from private to public: " + problem);
                });
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan set private', {
            description: "Change a channel from public to private.",
            details: [
                "Private channels are subject to access control.",
                "When they are open, they can be joined with v(join), otherwise the require an invite."
            ],
            args: ["channel"],
            minArgs: 0,
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOp(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("You are not an operator.");
                return true;
            }

            if (!this.isChannelPublic(env, targetchannelid)) {
                ep.reply("The channel was already private.");
                return true;
            }

            this.channelSetPrivate(env, targetchannelid)
                .then(() => {
                    ep.reply("The channel is now private.");
                    this.log("{" + env.name + "} [" + targetchannelid + "] Channel set to private.");
                })
                .catch((problem) => {
                    ep.reply("Unable to change channel from public to private.");
                    this.log("warn", "{" + env.name + "} [" + targetchannelid + "] Unable to change channel from public to private: " + problem);
                });
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan set accessrole', {
            description: "Set or clear the channel access role.",
            details: [
                "When the channel has an access role, joining the channel adds users to the role.",
                "Otherwise, users receive independent permission to view the channel.",
                "If you clear an existing access role, the users currently in it will receive independent permission to view the channel.",
                "Note: The role itself will never be created or deleted automatically."
            ],
            args: ["channel", "role"],
            minArgs: 0,
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
           
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOp(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("You are not an operator.");
                return true;
            }

            if (this.isChannelPublic(env, targetchannelid) && args.role) {
                ep.reply("This channel is public - users can't be excluded! Try setting it to private.");
                return true;
            }

            let roleid = null;
            if (args.role && args.role != "-") {
                let role = env.server.roles.find('name', args.role);
                if (role) {
                    roleid = role.id;
                } else if (env.server.roles.get(args.role)) {
                    roleid = args.role;
                } else {
                    ep.reply("Role not found.");
                    return true;
                }
            }

            let prevaccessroleid = this.getChannelData(env, targetchannelid).accessroleid;

            this.channelSetAccessRole(env, targetchannelid, roleid);

            let promise;
            if (prevaccessroleid && !roleid) {
                //Unsetting access role: Give individual access permission to role users
                let changeusers = [];
                let channel = env.server.channels.get(targetchannelid);
                let accessrole = env.server.roles.get(prevaccessroleid);
                if (channel && accessrole) {
                    for (let rolemember of accessrole.members.array()) {
                        changeusers.push(channel.overwritePermissions(rolemember, {VIEW_CHANNEL: true}, "Propagating permission to access role members on removal"));
                    }
                }
                promise = Promise.all(changeusers);
            } else {
                promise = Promise.resolve();
            }

            promise
                .then(() => {
                    if (roleid) {
                        ep.reply("Access role successfully set.");
                        this.log("{" + env.name + "} [" + targetchannelid + "] User " + userid + (roleid ? "set access role to " + roleid : "cleared access role") + ".");
                    } else {
                        ep.reply("Access role successfully cleared.");
                    }
                })
                .catch((problem) => {
                    ep.reply("Problem setting access role.");
                    this.log("warn", "{" + env.name + "} [" + targetchannelid + "] Problem when user " + userid + " tried to " + (roleid ? "set access role to " + roleid : "clear access role") + ": " + problem);
                });


            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan set owner', {
            description: "Transfer channel ownership to a specific user.",
            details: [
                "The channel owner (initially the channel creator) is responsible for the channel and can use clear commands.",
                "The owner must always be a channel operator.",
            ],
            args: ["channel", "newowner"],
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
           
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOwner(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("This command can only be used by the channel owner.");
                return true;
            }

            let targetuserid = env.displayNameToId(args.newowner) || args.newowner;
            if (!env.server.members.get(targetuserid)) {
                ep.reply("User not found.");
                return true;
            }

            if (!this.isUserChannelOp(env, targetchannelid, targetuserid)) {
                ep.reply("This user is not a channel operator.")
                return true;
            }

            this.channelSetOwner(env, targetchannelid, targetuserid);

            ep.reply("Owner successfully set.");
            this.log("{" + env.name + "} [" + targetchannelid + "] Owner set to: " + targetuserid + " (by " + userid + ").");

            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan open', {
            description: "Open a previously closed channel.",
            details: ["Open channels can be joined using the join/vjoin command."],
            args: ["channel"],
            minArgs: 0,
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOp(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("You are not an operator.");
                return true;
            }

            if (this.isChannelOpen(env, targetchannelid)) {
                ep.reply("The channel was already open.");
                return true;
            }

            this.channelOpen(env, targetchannelid);
            ep.reply("The channel is now open.");
            this.log("{" + env.name + "} [" + targetchannelid + "] Channel opened.");
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan close', {
            description: "Close a channel.",
            details: ["Closed channels can only be joined through an operator's use of the invite command."],
            args: ["channel"],
            minArgs: 0,
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOp(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("You are not an operator.");
                return true;
            }

            if (this.isChannelPublic(env, targetchannelid)) {
                ep.reply("This channel is public - users can't be excluded! Try setting it to private.");
                return true;
            }

            if (!this.isChannelOpen(env, targetchannelid)) {
                ep.reply("The channel was already closed.");
                return true;
            }

            this.channelClose(env, targetchannelid);
            ep.reply("The channel is now closed.");
            this.log("{" + env.name + "} [" + targetchannelid + "] Channel closed.");
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan info', {
            description: "Show information about an attached channel.",
            args: ["channel"],
            minArgs: 0,
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            let data = this.getChannelData(env, targetchannelid);

            let infoblock = "```\n";
            infoblock += `Environment:    ${data.env}\n`;
            infoblock += `Channel:        ${env.channelIdToDisplayName(data.channelid)}\n`;
            infoblock += `Owner:          ${env.idToDisplayName(data.creatorid)}\n`;
            infoblock += `Operators:      @${env.roleIdToDisplayName(data.opsroleid)} (${this.listChannelOps(env, data.channelid).length})\n`;
            if (!data.public) {
                infoblock += `Access:         ${data.accessroleid ? "@" + env.roleIdToDisplayName(data.accessroleid) : "Individual"}\n`;
            }
            infoblock += `Last used:      ${moment.unix(data.lastused).fromNow()}\n`;

            infoblock += `\n`;

            if (data.temp) infoblock += "This is a temporary channel.\n";
            if (data.key) infoblock += "This channel has a key.\n";
            if (data.public) {
                infoblock += "This channel is public (anyone can use it).\n";
            } else if (data.closed) {
                infoblock += "This channel is closed (invite only).\n";
            }

            infoblock += "```";
            ep.reply(infoblock);
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan clear users', {
            description: "Remove all channel users, excluding ops.",
            args: ["channel"],
            minArgs: 0,
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOwner(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("This command can only be used by the channel owner.");
                return true;
            }

            if (this.isChannelPublic(env, targetchannelid)) {
                ep.reply("This channel is public - users can't be excluded! Try setting it to private.");
                return true;
            }

            let data = this.getChannelData(env, targetchannelid);

            let kicks = [];
            for (let channeluserid of this.listChannelUsers(env, targetchannelid)) {
                if (this.isUserChannelOp(env, targetchannelid, channeluserid)) continue;
                kicks.push(this.userPartChannel(env, targetchannelid, channeluserid));
            }

            if (!kicks.length) {
                ep.reply("There is no one to kick!");
                return true;
            }

            Promise.all(kicks)
                .then(() => {
                    ep.reply("Kicked " + kicks.length + " user" + (kicks.length != 1 ? "s" : ""));
                    this.log("{" + env.name + "} [" + targetchannelid + " " + data.name + "] Clear users issued by owner " + userid + " affecting " + kicks.length + " user(s).");
                })
                .catch((problem) => {
                    ep.reply("Problem clearing users.");
                    this.log("warn", "{" + env.name + "} [" + targetchannelid + " " + data.name + "] Clear users issued by owner " + userid + " failed due to: " + problem);
                });
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'chan clear ops', {
            description: "Demote all channel ops, except for the owner.",
            args: ["channel"],
            minArgs: 0,
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOwner(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("This command can only be used by the channel owner.");
                return true;
            }

            let deops = [];
            for (let opuserid of this.listChannelOps(env, targetchannelid)) {
                if (this.isUserChannelOwner(env, targetchannelid, opuserid)) continue;
                deops.push(this.channelDeop(env, targetchannelid, opuserid));
            }

            if (!deops.length) {
                ep.reply("There is no one to demote!");
                return true;
            }

            Promise.all(deops)
                .then(() => {
                    ep.reply("Demoted " + deops.length + " operator" + (deops.length != 1 ? "s" : ""));
                    this.log("{" + env.name + "} [" + targetchannelid + "] Clear ops issued by owner " + userid + " affecting " + deops.length + " user(s).");
                })
                .catch((problem) => {
                    ep.reply("Problem demoting ops.");
                    this.log("warn", "{" + env.name + "} [" + targetchannelid + "] Clear ops issued by owner " + userid + " failed due to: " + problem);
                });
        
            return true;
        });


        let joinChannelHandler = (createTempChannelCallback, reqtype, createpublic) => (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.checkEnvUsable(env)) {
                ep.reply("I can't manage channels or roles in this environment.");
                return true;
            }

            let targetchannelid, channel = env.server.channels.filter((channel) => channel.type == reqtype).find('name', args.channel);
            if (channel) {
                targetchannelid = channel.id;
            } else if (env.server.channels.get(args.channel)) {
                targetchannelid = args.channel;
            }

            let getchannel = null;

            if (targetchannelid) {
                if (!this.isChannelAttached(env, targetchannelid)) {
                    ep.reply("This channel is not attached.");
                    return true;
                } else if (this.isChannelPublic(env, targetchannelid)) {
                    ep.reply("This channel is public - you always have access to it!");
                    return true;
                } else if (!this.isChannelOpen(env, targetchannelid)) {
                    ep.reply("This channel is not open for joining.");
                    return true;
                } else if (type != "private" && args.key && targetchannelid != channelid) {
                    ep.reply("You can't use the channel key in public! Channel automatically closed. An operator must change the key privately and reopen it using chan open.");
                    this.channelClose(env, targetchannelid);
                    this.log("{" + env.name + "} [" + targetchannelid + "] Channel closed due to public key usage attempt in " + channelid + " by " + userid + ".");
                    return true;
                } else {
                    let data = this.getChannelData(env, targetchannelid);
                    if (data.key && !this.isUserChannelOwner(userid) && data.key != args.key) {
                        ep.reply("Incorrect key.");
                        this.log("{" + env.name + "} [" + targetchannelid + "] Channel join attempt with incorrect key in " + channelid + " by " + userid + ".");
                        return true;
                    }
                    getchannel = Promise.resolve(data);
                }
            } else if (!this.param("tempchannels")) {
                ep.reply("Channel not found.");
                return true;
            } else if (createpublic && !this.param('publictempchannels')) {
                ep.reply("The creation of public temporary channels is disabled. Try a private channel.");
                return true;
            } else if (type != "private" && args.key) {
                ep.reply("You can't set the channel key in public! Try again in private, with a different key.");
                return true;
            } else {
                getchannel = createTempChannelCallback(env, args.channel, userid, createpublic);
                if (args.key && !createpublic) {
                    getchannel.then((data) => {
                        this.channelSetKey(env, data.channelid, args.key);
                    });
                }
            }

            getchannel
                .then((data) => this.userJoinChannel(env, data.channelid, userid))
                .then((result) => {
                    this.log("{" + env.name + "} [" + result.channeldata.channelid + "] join: " + result.userid);
                })
                .catch((problem) => {
                    ep.reply("Failed to join channel.");
                    this.log("warn", "{" + env.name + "} User " + userid + " could not join channel " + args.channel + " (" + targetchannelid + "): " + problem);
                });
        
            return true;
        };

        this.mod('Commands').registerCommand(this, 'join', {
            description: "Join an attached, open text channel or create a new temporary text channel.",
            details: ["This will give you permission to use the requested channel."],
            args: ["channel", "key"],
            minArgs: 1,
            environments: ["Discord"]
        }, joinChannelHandler(this.createTempTextChannel.bind(this), "text", this.param('defaulttopublic')));

        this.mod('Commands').registerCommand(this, 'vjoin', {
            description: "Join an attached, open voice channel or create a new temporary voice channel.",
            details: ["This will give you permission to use the requested channel."],
            args: ["channel", "key"],
            minArgs: 1,
            environments: ["Discord"]
        }, joinChannelHandler(this.createTempVoiceChannel.bind(this), "voice", this.param('defaulttopublic')));

        this.mod('Commands').registerCommand(this, 'join public', {
            description: "Join an attached, open text channel or create a new temporary text channel.",
            details: [
                "This will give you permission to use the requested channel.",
                "If the channel doesn't exist, it will be created as a public channel (visible to everyone)."
            ],
            args: ["channel"],
            minArgs: 1,
            environments: ["Discord"]
        }, joinChannelHandler(this.createTempTextChannel.bind(this), "text", true));

        this.mod('Commands').registerCommand(this, 'vjoin public', {
            description: "Join an attached, open voice channel or create a new temporary voice channel.",
            details: [
                "This will give you permission to use the requested channel.",
                "If the channel doesn't exist, it will be created as a public channel (visible to everyone)."
            ],
            args: ["channel"],
            minArgs: 1,
            environments: ["Discord"]
        }, joinChannelHandler(this.createTempVoiceChannel.bind(this), "voice", true));

        this.mod('Commands').registerCommand(this, 'join private', {
            description: "Join an attached, open text channel or create a new temporary text channel.",
            details: [
                "This will give you permission to use the requested channel.",
                "If the channel doesn't exist, it will be created as a private channel (with access control)."
            ],
            args: ["channel", "key"],
            minArgs: 1,
            environments: ["Discord"]
        }, joinChannelHandler(this.createTempTextChannel.bind(this), "text", false));

        this.mod('Commands').registerCommand(this, 'vjoin private', {
            description: "Join an attached, open voice channel or create a new temporary voice channel.",
            details: [
                "This will give you permission to use the requested channel.",
                "If the channel doesn't exist, it will be created as a private channel (with access control)."
            ],
            args: ["channel", "key"],
            minArgs: 1,
            environments: ["Discord"]
        }, joinChannelHandler(this.createTempVoiceChannel.bind(this), "voice", false));



        this.mod('Commands').registerCommand(this, 'part', {
            description: "Leave an attached text channel.",
            details: [
                "This will remove your permission to use the channel.",
                "If the channel is temporary, it will be destroyed when its last member leaves."
            ],
            args: ["channel"],
            minArgs: 0,
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (this.isChannelPublic(env, targetchannelid)) {
                ep.reply("This channel is public - it's always visible to everyone.");
                return true;
            }

            let replacementid = null;
            let channelusers = this.listChannelUsers(env, targetchannelid).filter((checkuserid) => checkuserid != userid);

            if (!channelusers.length) {
                //The last user leaves the channel
                if (this.isChannelTemporary(env, targetchannelid)) {
                    this.destroyTempChannel(env, targetchannelid)
                        .then(() => {
                            this.log("{" + env.name + "} [" + targetchannelid + "] part: " + userid + " (temporary channel destroyed)");
                        })
                        .catch((problem) => {
                            ep.reply("Could not destroy temporary channel.");
                            this.log("warn", "{" + env.name + "} User " + userid + " could not destroy temporary channel " + args.channel + " (" + targetchannelid + "): " + problem);
                        });
                    return true;
                }
            } else if (this.isUserChannelOwner(env, targetchannelid, userid)) {
                //Creator replacement
                let candidates = this.listChannelOps(env, targetchannelid).filter((checkuserid) => checkuserid != userid);
                if (candidates.length) {
                    replacementid = candidates[0];
                } else {
                    replacementid = channelusers[0];
                }
            }

            this.userPartChannel(env, targetchannelid, userid)
                .then((result) => {
                    this.log("{" + env.name + "} [" + result.channeldata.channelid + "] part: " + result.userid);
                    if (replacementid) {
                        this._data[env.name][targetchannelid].creatorid = replacementid;
                        this._data.save();
                        ep.reply(env.idToDisplayName(replacementid) + " is now the channel owner.");
                        this.log("{" + env.name + "} [" + result.channeldata.channelid + "] user " + replacementid + " is now the channel owner.");
                    }
                })
                .catch((problem) => {
                    ep.reply("Failed to part channel.");
                    this.log("warn", "{" + env.name + "} User " + userid + " could not part channel " + args.channel + " (" + targetchannelid + "): " + problem);
                });
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'invite', {
            description: "Invite a user to an attached channel.",
            args: ["channel", "user"],
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOp(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("You are not an operator.");
                return true;
            }

            if (this.isChannelPublic(env, targetchannelid)) {
                ep.reply("This channel is public - users always have access to it!");
                return true;
            }

            let targetuserid = env.displayNameToId(args.user) || args.user;
            if (!env.server.members.get(targetuserid)) {
                ep.reply("User not found.");
                return true;
            }

            if (this.isUserChannelMember(env, targetchannelid, targetuserid)) {
                ep.reply("The user is already in the channel.");
                return true;
            }

            this.userJoinChannel(env, targetchannelid, targetuserid)
                .then((result) => {
                    ep.reply("User " + env.idToDisplayName(targetuserid) + " has joined the channel.");
                    this.log("{" + env.name + "} [" + result.channeldata.channelid + "] Join: " + result.userid + " (invite by " + userid + ")");
                })
                .catch((problem) => {
                    ep.reply("Failed to invite to the channel.");
                    this.log("warn", "{" + env.name + "} User " + userid + " could not join channel " + args.channel + " (" + targetchannelid + "): " + problem);
                });
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'kick', {
            description: "Remove a user from an attached channel.",
            details: [
                "This will remove the user's permission to use the channel. If the user has a custom role that grants channel access, that role will not be removed.",
                "Operators can't be kicked."
            ],
            args: ["channel", "user"],
            environments: ["Discord"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let targetchannelid;
            if (!args.channel || args.channel == "-") {
                targetchannelid = channelid;
            } else {
                let channel = env.server.channels.find('name', args.channel);
                if (channel) {
                    targetchannelid = channel.id;
                } else if (env.server.channels.get(args.channel)) {
                    targetchannelid = args.channel;
                } else {
                    ep.reply("Channel not found.");
                    return true;
                }
            }

            if (!this.isChannelAttached(env, targetchannelid)) {
                ep.reply("This channel is not attached.");
                return true;
            }

            if (!this.isUserChannelOp(env, targetchannelid, userid) && !testIsModerator(env.name, userid, targetchannelid)) {
                ep.reply("You are not an operator.");
                return true;
            }

            if (this.isChannelPublic(env, targetchannelid)) {
                ep.reply("This channel is public - users can't be excluded! Try setting it to private.");
                return true;
            }

            let targetuserid = env.displayNameToId(args.user) || args.user;
            if (!env.server.members.get(targetuserid)) {
                ep.reply("User not found.");
                return true;
            }

            if (this.isUserChannelOp(env, targetchannelid, targetuserid)) {
                ep.reply("This user is an operator.");
                return true;
            }


            this.userPartChannel(env, targetchannelid, targetuserid)
                .then((result) => {
                    ep.reply("User " + env.idToDisplayName(targetuserid) + " was kicked from the channel.");
                    this.log("{" + env.name + "} [" + result.channeldata.channelid + "] Part: " + result.userid + "(kick by " + userid + ")");
                })
                .catch((problem) => {
                    ep.reply("Failed to kick from the channel.");
                    this.log("warn", "{" + env.name + "} User " + userid + " could not part channel " + args.channel + " (" + targetchannelid + "): " + problem);
                });
        
        
            return true;
        });


        return true;
    }
    
    
    // # Module code below this line #
    
    
    //API methods: These methods can be used from extension modules.
    //Many of these methods return promises; don't forget to catch rejections.

    isChannelAttached(env, channelid) {
        return this._data[env.name] && this._data[env.name][channelid];
    }

    isChannelOpen(env, channelid) {
        return this.isChannelAttached(env, channelid) && !this._data[env.name][channelid].closed;
    }

    isChannelTemporary(env, channelid) {
        return this.isChannelAttached(env, channelid) && this._data[env.name][channelid].temp;
    }

    isChannelPublic(env, channelid) {
        return this.isChannelAttached(env, channelid) && this._data[env.name][channelid].public;
    }

    isUserChannelOwner(env, channelid, userid) {
        if (!this.isChannelAttached(env, channelid)) return false;
        return userid == this._data[env.name][channelid].creatorid;
    }

    isUserChannelOp(env, channelid, userid) {
        if (!this.isChannelAttached(env, channelid)) return false;
        let member = env.server.members.get(userid);
        if (!member) return false;
        return !!member.roles.get(this._data[env.name][channelid].opsroleid);
    }

    isUserChannelMember(env, channelid, userid) {
        if (!this.isChannelAttached(env, channelid)) return false;
        let data = this._data[env.name][channelid];
        if (data.accessroleid) {
            let role = env.server.roles.get(data.accessroleid);
            if (!role) return false;
            return !!role.members.get(userid);
        } else {
            let channel = env.server.channels.get(channelid);
            let member = env.server.members.get(userid);
            return !!channel.permissionOverwrites.filter((po) => po.id == member.id && po.type == 'member' && (po.allow & 0x00000400)).array().length;            
        }
    }

    listAttachedChannels(env) {
        if (env.envName != "Discord") return [];
        if (!this._data[env.name]) return [];
        let result = [];
        for (let channelid in this._data[env.name]) {
            let channel = env.server.channels.get(channelid);
            result.push({channelid: channelid, name: (channel ? channel.name : channelid)});
        }
        result.sort((a, b) => a.name.localeCompare(b.name));
        return result;
    }

    getChannelData(env, channelid) {
        if (!this.isChannelAttached(env, channelid)) return false;
        let data = Object.assign({}, this._data[env.name][channelid]);
        let channel = env.server.channels.get(channelid);
        if (channel) data.name = channel.name;
        return data;
    }

    listChannelOps(env, channelid) {
        let data = this.getChannelData(env, channelid);
        if (!data) return false;
        let role = env.server.roles.get(data.opsroleid);
        if (!role) return false;
        let results = [];
        for (let member of role.members.array()) {
            results.push(member.id);
        }
        return results;
    }

    listChannelUsers(env, channelid) {
        let data = this.getChannelData(env, channelid);
        if (!data) return false;
        let results = [];
        if (data.accessroleid) {
            let role = env.server.roles.get(data.accessroleid);
            if (!role) return false;
            for (let member of role.members.array()) {
                if (member.id == env.server.me.id) continue;
                results.push(member.id);
            }
        } else {
            let channel = env.server.channels.get(channelid);
            for (let member of env.server.members.array()) {
                if (member.id == env.server.me.id) continue;
                if (!channel.permissionOverwrites.filter((po) => po.id == member.id && po.type == 'member' && (po.allow & 0x00000400)).array().length) continue;
                results.push(member.id);
            }
        }
        return results;
    }

    async channelAttach(env, channelid, roleid, creatorid) {
        if (this.isChannelAttached(env, channelid)) {
            this._data[env.name][channelid].accessroleid = (roleid ? roleid : null);
            this._data.save();
            return this._data[env.name][channelid];
        }

        let channel = env.server.channels.get(channelid);
        if (!channel) throw "Channel not found.";

        let opsrole = await this.doCreateOpsRole(env, channel.name, channel.type);
        await this.doAssignRoleToUser(env, opsrole.id, creatorid, "Promoting channel owner to operator");

        await channel.overwritePermissions(env.server.me.id, {VIEW_CHANNEL: true}, "Attaching channel");
        if (channel.type == "text") {
            await channel.overwritePermissions(opsrole, {VIEW_CHANNEL: true, MANAGE_CHANNELS: true, MANAGE_MESSAGES: true}, "Attaching channel (opsrole perms)");
        }
        if (channel.type == "voice") {
            await channel.overwritePermissions(opsrole, {VIEW_CHANNEL: true, MANAGE_CHANNELS: true, MUTE_MEMBERS: true, DEAFEN_MEMBERS: true}, "Attaching channel (opsrole perms)");
        }

        //Only way to check for guild + VIEW_CHANNELS in 11.3.2
        let ispublic = !channel.permissionOverwrites.filter((po) => po.id == env.server.id && po.type == 'role' && (po.deny & 0x00000400)).array().length;

        return this.doAttachChannel(env, channelid, channel.type, false, opsrole, roleid, creatorid, ispublic);
    }

    async channelDetach(env, channelid) {
        if (!this.isChannelAttached(env, channelid)) return false;
        this._deleting[channelid] = true;
        await this.doDestroyOpsRole(env, this._data[env.name][channelid].opsroleid);
        this.doDetachChannel(env, channelid);
        delete this._deleting[channelid];
        return true;
    }

    channelOp(env, channelid, userid) {
        if (!env.server.members.get(userid)) return Promise.reject("User not found.");
        if (!this.isChannelAttached(env, channelid)) return Promise.reject("Channel not attached.");
        let roleid = this._data[env.name][channelid].opsroleid;
        if (env.server.members.get(userid).roles.get(roleid)) return Promise.resolve();
        let role = env.server.roles.get(roleid);
        if (!role) return Promise.reject("Role not found.");
        return env.server.members.get(userid).addRole(role, "Turning user into channel op");
    }

    channelDeop(env, channelid, userid) {
        if (!env.server.members.get(userid)) return Promise.reject("User not found.");
        if (!this.isChannelAttached(env, channelid)) return Promise.reject("Channel not attached.");
        let roleid = this._data[env.name][channelid].opsroleid;
        if (!env.server.members.get(userid).roles.get(roleid)) return Promise.resolve();
        let role = env.server.roles.get(roleid);
        if (!role) return Promise.reject("Role not found.");
        return env.server.members.get(userid).removeRole(role, "Demoting user from channel op");
    }

    channelSetKey(env, channelid, key) {
        if (!this._data[env.name] || !this._data[env.name][channelid]) return false;
        this._data[env.name][channelid].key = (key ? key : null);
        this._data.save();
        return true;
    }

    channelOpen(env, channelid) {
        if (!this._data[env.name] || !this._data[env.name][channelid]) return false;
        this._data[env.name][channelid].closed = false;
        this._data.save();
        return true;
    }

    channelClose(env, channelid) {
        if (!this._data[env.name] || !this._data[env.name][channelid]) return false;
        this._data[env.name][channelid].closed = true;
        this._data.save();
        return true;
    }

    async channelSetPublic(env, channelid) {
        if (!this._data[env.name] || !this._data[env.name][channelid]) throw "Channel not attached.";
        let channel = env.server.channels.get(channelid);
        if (!channel) throw "Channel not found.";
        await channel.overwritePermissions(env.server.id, {VIEW_CHANNEL: true}, "Changing channel to public");
        this._data[env.name][channelid].public = true;
        this._data.save();
        return true;
    }

    async channelSetPrivate(env, channelid) {
        if (!this._data[env.name] || !this._data[env.name][channelid]) throw "Channel not attached.";
        let channel = env.server.channels.get(channelid);
        if (!channel) throw "Channel not found.";
        await channel.overwritePermissions(env.server.id, {VIEW_CHANNEL: false}, "Changing channel to private");
        this._data[env.name][channelid].public = false;
        this._data.save();
        return true;
    }

    channelSetAccessRole(env, channelid, roleid) {
        if (!this._data[env.name] || !this._data[env.name][channelid]) return false;
        if (roleid && !env.server.roles.get(roleid)) return false;
        this._data[env.name][channelid].accessroleid = (roleid ? roleid : null);
        this._data.save();
        return true;
    }

    channelSetOwner(env, channelid, userid) {
        if (!this._data[env.name] || !this._data[env.name][channelid]) return false;
        if (!env.server.members.get(userid)) return false;
        this._data[env.name][channelid].creatorid = userid;
        this._data.save();
        return true;
    }

    userJoinChannel(env, channelid, userid) {
        if (!env.server.members.get(userid)) return Promise.reject("User not found.");
        if (!this.isChannelAttached(env, channelid)) return Promise.reject("Channel not attached.");
        let channeldata = this._data[env.name][channelid];
        if (channeldata.accessroleid) {
            if (env.server.members.get(userid).roles.get(channeldata.accessroleid)) return Promise.resolve({channeldata: channeldata, userid: userid});
            return env.server.members.get(userid).addRole(channeldata.accessroleid, "Granting channel access to user")
                .then(() => ({channeldata: channeldata, userid: userid}));
        } else {
            let channel = env.server.channels.get(channelid);
            if (!channel) return Promise.reject("Channel not found.");            
            if (channel.permissionOverwrites.filter((po) => po.id == userid && po.type == 'member' && (po.allow & 0x00000400)).get(userid)) {
                return Promise.resolve({channeldata: channeldata, userid: userid});
            }
            return channel.overwritePermissions(env.server.members.get(userid), {VIEW_CHANNEL: true}, "Granting channel access to user")
                .then(() => ({channeldata: channeldata, userid: userid}));
        }
    }

    async userPartChannel(env, channelid, userid) {
        if (!env.server.members.get(userid)) throw "User not found.";
        if (!this.isChannelAttached(env, channelid)) throw "Channel not attached.";
        let channeldata = this._data[env.name][channelid];
        if (this.isUserChannelOp(env, channelid, userid)) {
            await this.channelDeop(env, channelid, userid);
        }
        if (channeldata.accessroleid) {
            if (!env.server.members.get(userid).roles.get(channeldata.accessroleid)) return {channeldata: channeldata, userid: userid};
            return env.server.members.get(userid).removeRole(channeldata.accessroleid, "Revoking channel access from user")
                .then(() => ({channeldata: channeldata, userid: userid}));
        } else {
            let channel = env.server.channels.get(channelid);
            if (!channel) throw "Channel not found.";
            let joinpermission = channel.permissionOverwrites.filter((po) => po.id == userid && po.type == 'member' && (po.allow & 0x00000400)).get(userid);
            if (joinpermission) return joinpermission.delete("Revoking channel access from user").then(() => ({channeldata: channeldata, userid: userid}));
            return {channeldata: channeldata, userid: userid};
        }
    }

    async createTempTextChannel(env, name, creatorid, ispublic) {
        if (env.envName != "Discord") throw "Invalid environment type.";
        let role = await this.doCreateOpsRole(env, name, "text");
        await this.doAssignRoleToUser(env, role.id, creatorid, "Promoting channel owner to operator");
        let perms = [{id: env.server.me.id, allow: ['VIEW_CHANNEL']}];
        if (ispublic) {
            perms.push({id: env.server.id, allow: ['VIEW_CHANNEL']});
        } else {
            perms.push({id: env.server.id, deny: ['VIEW_CHANNEL']});
        }
        perms.push({id: role.id, allow: ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_MESSAGES']});
        let channel = await env.server.createChannel(name, "text", perms, "Temporary text channel");
        if (this.param("textcategory")) {
            let category = env.server.channels.get(this.param("textcategory"));
            if (category) {
                await channel.setParent(category, "Setting category of temporary text channel");
            }
        }
        return this.doAttachChannel(env, channel.id, channel.type, true, role, null, creatorid, ispublic);
    }

    async createTempVoiceChannel(env, name, creatorid, ispublic) {
        if (env.envName != "Discord") throw "Invalid environment type.";
        let role = await this.doCreateOpsRole(env, name, "voice");
        await this.doAssignRoleToUser(env, role.id, creatorid, "Promoting channel owner to operator");
        let perms = [{id: env.server.me.id, allow: ['VIEW_CHANNEL']}];
        if (ispublic) {
            perms.push({id: env.server.id, allow: ['VIEW_CHANNEL']});
        } else {
            perms.push({id: env.server.id, deny: ['VIEW_CHANNEL']});
        }
        perms.push({id: role.id, allow: ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS']});
        let channel = await env.server.createChannel(name, "voice", perms, "Temporary voice channel");
        if (this.param("voicecategory")) {
            let category = env.server.channels.get(this.param("voicecategory"));
            if (category) {
                await channel.setParent(category, "Setting category of temporary voice channel");
            }
        }
        return this.doAttachChannel(env, channel.id, channel.type, true, role, null, creatorid, ispublic);
    }

    async destroyTempChannel(env, channelid) {
        if (env.envName != "Discord") throw "Invalid environment type.";
        if (!this.isChannelAttached(env, channelid)) throw "Channel not attached.";
        let data = this.getChannelData(env, channelid);
        if (!data.temp) throw "Channel not temporary.";
        this._deleting[channelid] = true;
        let channel = env.server.channels.get(channelid);
        if (channel) await channel.delete("Deleting temporary channel");
        await this.doDestroyOpsRole(env, data.opsroleid);
        this.doDetachChannel(env, channelid);
        delete this._deleting[channelid];
        return true;
    }


    //Auxiliary methods: Signature might change, don't call from other modules.

    doAttachChannel(env, channelid, type, temp, opsrole, accessroleid, creatorid, ispublic) {
        if (!this._data[env.name]) this._data[env.name] = {};
        if (this._data[env.name][channelid]) return false;
        this._data[env.name][channelid] = {
            env: env.name,
            channelid: channelid,
            type: type,
            creatorid: creatorid,
            accessroleid: (accessroleid ? accessroleid : null),
            opsroleid: opsrole.id,
            key: null,
            temp: !!temp,
            closed: false,
            public: !!ispublic,
            lastused: moment().unix()
        };
        this._data.save();
        return this._data[env.name][channelid];
    }

    doDetachChannel(env, channelid) {
        if (!this._data[env.name] || !this._data[env.name][channelid]) return false;
        delete this._data[env.name][channelid];
        this._data.save();
        return true;
    }

    doCreateOpsRole(env, name, type) {
        return env.server.createRole({name: name + ":ops", color: this.param("opscolor"), permissions: [], mentionable: false}, "Ops role for temporary voice channel '" + name + "'");
    }

    doDestroyOpsRole(env, roleid) {
        let role = env.server.roles.get(roleid);
        if (!role || !role.name.match(/:ops$/)) return Promise.reject("Role not found or not ops role.");
        return role.delete("Deleting ops role");
    }

    doAssignRoleToUser(env, roleid, userid, reason) {
        if (!env.server.members.get(userid)) return Promise.reject("User not found.");
        if (env.server.members.get(userid).roles.get(roleid)) return Promise.resolve();
        return env.server.members.get(userid).addRole(roleid, reason);
    }

    doTouchChannel(env, channelid) {
        if (!this._data[env.name] || !this._data[env.name][channelid]) return false;
        this._data[env.name][channelid].lastused = moment().unix();
        this._data.save();
        return true;
    }

    checkEnvUsable(env) {
        return env.server.me.hasPermission("MANAGE_CHANNELS") && env.server.me.hasPermission("MANAGE_ROLES");
    }

    checkSecsSinceLastUsed(env, channelid) {
        if (!this._data[env.name] || !this._data[env.name][channelid]) return false;
        return moment().unix() - this._data[env.name][channelid].lastused;
    }


}


module.exports = ModDiscordChannels;
