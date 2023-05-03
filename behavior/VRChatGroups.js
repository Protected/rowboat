/* Module: VRChatGroups -- Allows the bot to be in VRChat groups and provides group-related features. */

const moment = require('moment');
const { EmbedBuilder } = require('discord.js');

const Module = require('../Module.js');

const PERM_ADMIN = 'administrator';


class ModVRChatGroups extends Module {

    get requiredParams() { return [
        "env"
    ]; }

    get optionalParams() { return [
        "memberfreq",           //How often to check group members (s)
        "announcefreq",         //How often to check group announcements (s)
        "rolefreq",             //How often to check group roles (s)
        "ddelay",               //Delay between actions in the delayed action queue (ms) [used to prevent rate limiting]

        "colannounceactive",    //Color for active announcements
        "colannounceold",        //Color for old announcements
        "colrepresenting",      //Color for members who are online and representing

        "inemoji",              //Emoji for new members
        "outemoji"              //Emoji for departed members
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands',
        'VRChat'
    ]; }

    get vrchat() {
        return this.mod("VRChat");
    }

    get denv() {
        return this.env(this.param('env'));
    }

    constructor(name) {
        super('VRChatGroups', name);

        this._params["memberfreq"] = 300;
        this._params["announcefreq"] = 160;
        this._params["rolefreq"] = 1805;
        this._params["ddelay"] = 500;

        this._params["colannounceactive"] = [255, 40, 30];
        this._params["colannounceold"] = [200, 200, 200];
        this._params["colrepresenting"] = [255, 120, 244];

        this._params["inemoji"] = "📥";
        this._params["outemoji"] = "📤";

        this._active = false;
        this._awaitActive = null;
        
        //Cached
        this._groups = null;  //{GROUPID: {...GROUP...}, ...}
        this._nameIndex = {};  //{NAMELOWERCASE: GROUPID, ...}

        /*{GROUPID: {
                group: GROUPID, announcements: CHANNELID, members: CHANNELID, greet: CHANNELID, grouproles: [{grouprole, discordrole}, ...]
                announcementMsgs: {announcementid: msgid, ...}, memberMsgs: {vrcuserid: msgid, ...}
            }, ...}*/
        this._groupChannels = null;

        this._groupIndex = {};  //{CHANNELID: [...GROUPID...], ...}
        this._grouproleIndex = {};  //{ROLEID: [...GROUPID...], ...}

        this._dqueue = [];  //Update queue
        this._dtimer = null;  //Update queue timer
        this._dbusy = false;  //Wait for asynchronous entries

        this._mtimer = null;  //Group members timer
        this._atimer = null;  //Group announcement timer
        this._rtimer = null;  //Group roles timer
    }


    initialize(opt) {
        if (!super.initialize(opt)) return false;

        
        //# Load saved data

        this._groups = this.loadData(this.name.toLowerCase() + ".cache.json", {}, {quiet: true});

        this._groupChannels = this.loadData(undefined, {}, {quiet: true});
        for (let groupid in this._groupChannels) {
            this.indexChannels(this._groupChannels[groupid]);
            this.indexRoles(this._groupChannels[groupid]);
        }


        //# Register VRChat callbacks

        this._awaitActive = new Promise((resolve, reject) => {
            this.vrchat.registerConnectCallback(async () => {
                try {
                    let groupMemberships = await this.vrchat.getMyGroupMemberships();
                    for (let groupMembership of groupMemberships) {
                        let group = this._groups[groupMembership.groupId] || {};
                        let updategroup = await this.vrchat.vrcGroup(groupMembership.groupId, true);
                        group = Object.assign(group, updategroup);
                        this._groups[group.id] = group;
                        this._groups.save();
                        this._nameIndex[group.name.toLowerCase()] = group.id;

                        this.dqueue(async function() {
                            await this.updateGroupMembers(group.id);
                            await this.updateGroupAnnouncement(group.id);
                        }.bind(this));
                    }
                    this._active = true;
                    resolve();
                } catch (e) {
                    this.log("error", "Error when trying to retrieve list of groups: " + JSON.stringify(e));
                    reject();
                }
            });
        });

        this.vrchat.registerWebsocketCallback("group-joined", async (content) => {
            if (!this._groups[content.groupId]) {
                let group = await this.vrchat.vrcGroup(content.groupId, true);
                this._groups[group.id] = group;
                this._groups.save();
                this._nameIndex[group.name.toLowerCase()] = group.id;
            }

            ep.reply("I am now a member of " + this._groups[content.groupId].name + ".");
        });

        this.vrchat.registerWebsocketCallback("group-left", (content) => {
            let name = content.groupId;
            if (this._groups[content.groupId]) {
                name = this._groups[content.groupId].name;
                delete this._groups[content.groupId];
                this._groups.save();
                delete this._nameIndex[name.toLowerCase()];
            }

            this.unsetGroupChannelsAndRoles(content.groupId);

            this.vrchat.announce("I am no longer in the group " + name + ".");
        });

        this.vrchat.registerWebsocketCallback("friend-state-change", (content) => {
            for (let vrcgroupid in this._groupChannels) {
                if (this._groups[vrcgroupid].members?.find(member => member.userId == content.userId)) {
                    this.dqueue(function() {
                        this.bakeMember(vrcgroupid, content.userId);
                    }.bind(this));
                }
            }
        });


        //# Cleanup handler

        opt.pushCleanupHandler((next) => {
            for (let vrcgroupid in this._groupChannels) {
                this.dqueue(function () {
                    this.toggleMembersOff(vrcgroupid);
                }.bind(this));
            }
            this.dqueue(next);
        });


        //# Register Discord callbacks

        let roleDeleteHandler = (role) => {
            if (!this._grouproleIndex[role.id]) return;

            //Remove assignments
            for (let vrcgroupid of this._grouproleIndex[role.id]) {
                this.unsetGroupRole(vrcgroupid, role.id);
            }

        };

        let channelDeleteHandler = (channel) => {
            if (!this._groupIndex[channel.id]) return;

            //Remove assignments
            for (let vrcgroupid of this._groupIndex[channel.id]) {
                this.unsetGroupChannelsById(vrcgroupid, channel.id);
            }

        };

        let messageDeleteHandler = (message) => {
        
            //Clear deleted message references

            for (let vrcgroupid in this._groupChannels) {
                let groupsettings = this._groupChannels[vrcgroupid];
                for (let vrcpostid in groupsettings.announcementMsgs) {
                    if (groupsettings.announcementMsgs[vrcpostid] == message.id) {
                        delete groupsettings.announcementMsgs[vrcpostid];
                    }
                }
                for (let vrcuserid in groupsettings.memberMsgs) {
                    if (groupsettings.memberMsgs[vrcuserid] == message.id) {
                        delete groupsettings.memberMsgs[vrcuserid];
                    }
                }
            }

        };

        this.denv.on("connected", async () => {

            //Check for missing roles
            await this.denv.server.roles.fetch();
            for (let roleid in this._grouproleIndex) {
                if (!this.denv.server.roles.cache.get(roleid)) {
                    for (let vrcgroupid of this._grouproleIndex[roleid]) {
                        this.unsetGroupRole(vrcgroupid, roleid);
                    }
                }
            }

            //Check for missing channels
            await this.denv.server.channels.fetch();
            for (let channelid in this._groupIndex) {
                if (!this.denv.server.channels.cache.get(channelid)) {
                    for (let vrcgroupid of this._groupIndex[channelid]) {
                        this.unsetGroupChannelsById(vrcgroupid, channelid);
                    }
                }
            }

            this._awaitActive
                .then(async () => {
                    for (let vrcgroupid in this._groupChannels) {
                        if (!this._groups[vrcgroupid]) {

                            //Missing VRChat groups (missing membership)
                            this.unsetGroupChannelsAndRoles(vrcgroupid);

                        } else {

                            //Check for missing VRChat group roles
                            for (let assignment of this._groupChannels[vrcgroupid].grouproles) {
                                if (assignment.grouprole === true) continue;
                                if (!this._groups[vrcgroupid].roles.find(grouprole => grouprole.id == assignment.grouprole)) {
                                    this.unsetGroupRole(vrcgroupid, assignment.discordrole);
                                }
                            }

                            //Clear deleted message references
                            
                            for (let vrcpostid in this._groupChannels[vrcgroupid].announcementMsgs) {
                                let message = await this.getAnnouncementMessage(vrcgroupid, vrcpostid);
                                if (message) continue;
                                delete this._groupChannels[vrcgroupid].announcementMsgs[vrcpostid];
                            }

                            for (let vrcuserid in this._groupChannels[vrcgroupid].memberMsgs) {
                                let message = await this.getMemberMessage(vrcgroupid, vrcuserid);
                                if (message) continue;
                                delete this._groupChannels[vrcgroupid].memberMsgs[vrcuserid];
                            }

                        }
                    }
                });

            this.denv.client.on("roleDelete", roleDeleteHandler);
            this.denv.client.on("channelDelete", channelDeleteHandler);
            this.denv.client.on("messageDelete", messageDeleteHandler);
        });


        //# Start automation timers

        this._dtimer = setInterval(function () {

            if (!this._dqueue || this._dbusy) return;
            let item = this._dqueue.shift();
            if (!item) return;
            let ret = item();
            if (ret?.then) {
                this._dbusy = true;
                ret.finally(() => { this._dbusy = false; });
            }

        }.bind(this), this.param("ddelay"));

        this._awaitActive
            .then(() => {
                //Only start group checks after group bootstrap is completed

                this._mtimer = setInterval(function () {
                    for (let vrcgroupid in this._groups) {
                        this.dqueue(function() {
                            this.updateGroupMembers(vrcgroupid);
                        }.bind(this));
                    }
                }.bind(this), this.param("memberfreq") * 1000);

                this._atimer = setInterval(function () {
                    for (let vrcgroupid in this._groups) {
                        this.dqueue(function() {
                            this.updateGroupAnnouncement(vrcgroupid);
                        }.bind(this));
                    }
                }.bind(this), this.param("announcefreq") * 1000);

                this._rtimer = setInterval(function () {
                    for (let vrcgroupid in this._groups) {
                        this.dqueue(function() {
                            this.updateGroupRoles(vrcgroupid);
                        }.bind(this));
                    }
                }.bind(this), this.param("rolefreq") * 1000);
            });


        //# Register commands

        this.mod('Commands').registerCommand(this, 'vrcgroup join', {
            description: "Joins a group.",
            args: ["groupid"],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this._active) {
                ep.reply("I'm still trying to retrieve the list of groups from VRChat.");
                return true;
            }

            try {
                let membership = await this.vrchat.vrcGroupJoin(args.groupid);
                let group = await this.vrchat.vrcGroup(membership.groupId, true);
                this._groups[group.id] = group;
                this._groups.save();
                this._nameIndex[group.name.toLowerCase()] = group.id;
                if (membership.membershipStatus == "requested") {
                    ep.reply("I have requested an invitation to join " + group.name + ".");
                } else {
                    ep.reply("I am now a member of " + group.name + ".");
                }
            } catch (e) {
                if (e.statusCode == 400) {
                    ep.reply("I'm already in that group!");
                } else if (e.statusCode == 404) {
                    ep.reply("That group doesn't exist!");
                } else {
                    this.log("error", "Error when trying to join group " + args.groupid + ": " + JSON.stringify(e));
                    ep.reply("There was an error when trying to join the group.");
                }
            }

            return true;
        });

        this.mod('Commands').registerCommand(this, 'vrcgroup leave', {
            description: "Leaves a group.",
            args: ["group", true],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this._active) {
                ep.reply("I'm still trying to retrieve the list of groups from VRChat.");
                return true;
            }

            let group = args.group.join(" ");
            if (!this._groups[group] && this._nameIndex[group.toLowerCase()]) {
                group = this._nameIndex[group.toLowerCase()];
            }
            if (!this._groups[group]) {
                ep.reply("I'm not in this group!");
                return true;
            }

            try {
                await this.vrchat.vrcGroupLeave(group);
                let name = this._groups[group].name;
                delete this._groups[group];
                this._groups.save();
                delete this._nameIndex[name.toLowerCase()];

                this.unsetGroupChannelsAndRoles(group);

                ep.reply("I have left the group " + name + ".");
            } catch (e) {
                if (e.statusCode == 403) {
                    ep.reply("I'm not in that group anymore!");
                } else if (e.statusCode == 404) {
                    ep.reply("That group doesn't exist!");
                } else {
                    this.log("error", "Error when trying to leave group " + args.id + ": " + JSON.stringify(e));
                    ep.reply("There was an error when trying to leave the group.");
                }
            }

            return true;
        });

        this.mod('Commands').registerCommand(this, 'vrcgroup invite', {
            description: "Invites the user to a group.",
            args: ["group", true]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this._active) {
                ep.reply("I'm still trying to retrieve the list of groups from VRChat.");
                return true;
            }

            let group = args.group.join(" ");
            if (!this._groups[group] && this._nameIndex[group.toLowerCase()]) {
                group = this._nameIndex[group.toLowerCase()];
            }
            if (!this._groups[group]) {
                ep.reply("I'm not in this group!");
                return true;
            }

            let person = this.vrchart.getPerson(userid);
            if (!person) {
                ep.reply("I don't know who you are!");
                return true;
            }

            try {
                await this.vrchat.vrcGroupInvite(group, person.vrc);
                ep.reply("I have invited " + person.name + " to " + this._groups[group].name);
            } catch (e) {
                if (e.statusCode == 400) {
                    ep.reply("You're already invited!");
                } else if (e.statusCode == 404) {
                    ep.reply("That group doesn't exist!");
                } else {
                    this.log("error", "Error when trying to invite to group " + group + ": " + JSON.stringify(e));
                    ep.reply("There was an error when trying to issue the invitation.");
                }
            }

            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrcgroup announcements', {
            description: "Set/unset a discord channel for displaying group announcements.",
            details: [
                "Use '-' instead of a channel to unset the channel."
            ],
            args: ["channel", "group", true],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let group = args.group.join(" ");
            if (!this._groups[group] && this._nameIndex[group.toLowerCase()]) {
                group = this._nameIndex[group.toLowerCase()];
            }
            if (!this._groups[group]) {
                ep.reply("I'm not in this group!");
                return true;
            }

            if (args.channel == "-" || args.channel == "no" || args.channel == "off" || args.channel == "0") {
                this.unsetGroupAnnouncements(group);
            } else {
                this.setGroupAnnouncements(group, env.extractChannelId(args.channel));
            }

            ep.ok();

            return true;
        });

        this.mod('Commands').registerCommand(this, 'vrcgroup members', {
            description: "Set/unset a discord channel for displaying group members.",
            details: [
                "Use '-' instead of a channel to unset the channel."
            ],
            args: ["channel", "group", true],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let group = args.group.join(" ");
            if (!this._groups[group] && this._nameIndex[group.toLowerCase()]) {
                group = this._nameIndex[group.toLowerCase()];
            }
            if (!this._groups[group]) {
                ep.reply("I'm not in this group!");
                return true;
            }

            if (args.channel == "-" || args.channel == "no" || args.channel == "off" || args.channel == "0") {
                this.unsetGroupMembers(group);
            } else {
                this.setGroupMembers(group, env.extractChannelId(args.channel));
            }

            ep.ok();

            return true;
        });

        this.mod('Commands').registerCommand(this, 'vrcgroup greet', {
            description: "Set/unset a discord channel for announcing when members join/leave a group.",
            details: [
                "Use '-' instead of a channel to unset the channel."
            ],
            args: ["channel", "group", true],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let group = args.group.join(" ");
            if (!this._groups[group] && this._nameIndex[group.toLowerCase()]) {
                group = this._nameIndex[group.toLowerCase()];
            }
            if (!this._groups[group]) {
                ep.reply("I'm not in this group!");
                return true;
            }

            if (args.channel == "-" || args.channel == "no" || args.channel == "off" || args.channel == "0") {
                this.unsetGroupGreet(group);
            } else {
                this.setGroupGreet(group, env.extractChannelId(args.channel));
            }

            ep.ok();

            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrcgroup role', {
            description: "Automatically synchronize a discord role with a group role.",
            details: [
                "Use '-' instead of the group role to remove the assignment.",
                "Omit the group role to assign to basic group membership."
            ],
            args: ["role", "group", "grouprole", true],
            minArgs: 2,
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let group = args.group;
            if (!this._groups[group] && this._nameIndex[group.toLowerCase()]) {
                group = this._nameIndex[group.toLowerCase()];
            }
            if (!this._groups[group]) {
                ep.reply("I'm not in this group!");
                return true;
            }

            let roleid = env.extractRoleId(args.role);
            if (!env.server.roles.cache.get(roleid)) {
                ep.reply("There is no such Discord role!");
                return true;
            }

            let grouprole = args.grouprole.join(" ");

            if (grouprole == "-" || grouprole == "off"  || grouprole == "no" || grouprole == "0") {

                this.unsetGroupRole(group, roleid);
                ep.ok();

            } else {

                if (!grouprole || grouprole == "on" || grouprole == "yes" || grouprole == "1") {
                    grouprole = true;
                } else {
                    let grouproledata = this._groups[group].roles.find(each => each.id == grouprole);
                    if (!grouproledata) grouproledata = this._groups[group].roles.find(each => each.name.toLowerCase() == grouprole.toLowerCase());
                    if (grouproledata) {
                        grouprole = grouproledata.id;
                    } else {
                        ep.reply("Group role not found in the group!");
                        return true;
                    }
                }

                this.setGroupRole(group, roleid, grouprole);

                ep.ok();

            }

            return true;
        });


        return true;
    };



    // # Module code below this line #


    //Build indices from authoritative map data

    indexChannels(channeldata) {
        if (channeldata.announcements) {
            if (!this._groupIndex[channeldata.announcements]) {
                this._groupIndex[channeldata.announcements] = [channeldata.group];
            } else {
                this._groupIndex[channeldata.announcements].push(channeldata.group);
            }
        }
        if (channeldata.members) {
            if (!this._groupIndex[channeldata.members]) {
                this._groupIndex[channeldata.members] = [channeldata.group];
            } else {
                this._groupIndex[channeldata.members].push(channeldata.group);
            }
        }
        if (channeldata.greet) {
            if (!this._groupIndex[channeldata.greet]) {
                this._groupIndex[channeldata.greet] = [channeldata.group];
            } else {
                this._groupIndex[channeldata.greet].push(channeldata.group);
            }
        }
    }

    unindexChannelsCheck(channelid, channeldata) {
        if (!channelid) return false;
        if (channeldata.announcements == channelid || channeldata.members == channelid || channeldata.greet == channelid) {
            return false;
        }
        if (this._groupIndex[channelid]) {
            this._groupIndex[channelid] = this._groupIndex[channelid].filter(vrcgroupid => vrcgroupid != channeldata.group);
        }
        return true;
    }

    indexRoles(channeldata) {
        if (!channeldata.grouproles) return;
        for (let assignment of channeldata.grouproles) {
            if (!this._grouproleIndex[assignment.discordrole]) {
                this._grouproleIndex[assignment.discordrole] = [channeldata.group];
            } else {
                this._grouproleIndex[assignment.discordrole].push(channeldata.group);
            }
        }
    }

    unindexRole(roleid, vrcgroupid) {
        if (!this.grouproleIndex[vrcgroupid]) return;
        this.grouproleIndex[vrcgroupid] = this.grouproleIndex[vrcgroupid].filter(check => check != roleid);
    }


    //Manipulate settings

    initializeGroupChannels(vrcgroupid) {
        if (!this._groupChannels[vrcgroupid]) {
            this._groupChannels[vrcgroupid] = {
                group: vrcgroupid,
                announcements: null,
                members: null,
                greet: null,
                grouproles: [],
                memberMsgs: {},
                announcementMsgs: {}
            };
        }
    }

    setGroupAnnouncements(vrcgroupid, channelid) {
        this.initializeGroupChannels(vrcgroupid);
        let old = this._groupChannels[vrcgroupid].announcements;
        this._groupChannels[vrcgroupid].announcements = channelid;
        this._groupChannels.save();
        this.unindexChannelsCheck(old, this._groupChannels[vrcgroupid]);
        this.indexChannels(this._groupChannels[vrcgroupid]);
    }

    unsetGroupAnnouncements(vrcgroupid) {
        if (!this._groupChannels[vrcgroupid]) return;
        let old = this._groupChannels[vrcgroupid].announcements;
        this._groupChannels[vrcgroupid].announcements = null;
        this._groupChannels.save();
        this.unindexChannelsCheck(old, this._groupChannels[vrcgroupid]);
    }

    setGroupMembers(vrcgroupid, channelid) {
        this.initializeGroupChannels(vrcgroupid);
        let old = this._groupChannels[vrcgroupid].members;
        this._groupChannels[vrcgroupid].members = channelid;
        this._groupChannels.save();
        this.unindexChannelsCheck(old, this._groupChannels[vrcgroupid]);
        this.indexChannels(this._groupChannels[vrcgroupid]);
    }

    unsetGroupMembers(vrcgroupid) {
        if (!this._groupChannels[vrcgroupid]) return;
        let old = this._groupChannels[vrcgroupid].members;
        this._groupChannels[vrcgroupid].members = null;
        this._groupChannels.save();
        this.unindexChannelsCheck(old, this._groupChannels[vrcgroupid]);
    }

    setGroupGreet(vrcgroupid, channelid) {
        this.initializeGroupChannels(vrcgroupid);
        let old = this._groupChannels[vrcgroupid].greet;
        this._groupChannels[vrcgroupid].greet = channelid;
        this._groupChannels.save();
        this.unindexChannelsCheck(old, this._groupChannels[vrcgroupid]);
        this.indexChannels(this._groupChannels[vrcgroupid]);
    }

    unsetGroupGreet(vrcgroupid) {
        if (!this._groupChannels[vrcgroupid]) return;
        let old = this._groupChannels[vrcgroupid].greet;
        this._groupChannels[vrcgroupid].greet = null;
        this._groupChannels.save();
        this.unindexChannelsCheck(old, this._groupChannels[vrcgroupid]);
    }

    unsetGroupChannelsById(vrcgroupid, channelid) {
        if (!this._groupChannels[vrcgroupid]) return;
        if (this._groupChannels[vrcgroupid].announcements == channelid) {
            this.unsetGroupAnnouncements(vrcgroupid);
        }
        if (this._groupChannels[vrcgroupid].members == channelid) {
            this.unsetGroupMembers(vrcgroupid);
        }
        if (this._groupChannels[vrcgroupid].greet == channelid) {
            this.unsetGroupGreet(vrcgroupid);
        }
    }

    getGroupRole(vrcgroupid, roleid) {
        return this._groupChannels[vrcgroupid]?.grouproles.find(assignment => assignment.discordrole == roleid)?.grouprole;
    }

    getRolesByGroupRole(vrcgroupid, vrcgrouproleid) {
        return this._groupChannels[vrcgroupid]?.grouproles.filter(assignment => assignment.grouprole == vrcgrouproleid).map(assignment => assignment.discordrole);
    }

    getMultipleRolesByGroupRoles(vrcgroupid, vrcgrouproleids) {
        if (!vrcgrouproleids || !vrcgrouproleids.length || !this._groupChannels[vrcgroupid]) return [];
        return this._groupChannels[vrcgroupid].grouproles.filter(assignment => vrcgrouproleids.includes(assignment.grouprole)).map(assignment => assignment.discordrole);
    }

    setGroupRole(vrcgroupid, roleid, vrcgrouproleid) {
        this.initializeGroupChannels(vrcgroupid);
        let existing = this._groupChannels[vrcgroupid].grouproles.find(assignment => assignment.discordrole == roleid);
        if (existing) {
            existing.grouprole = vrcgrouproleid;
        } else {
            this._groupChannels[vrcgroupid].grouproles.push({discordrole: roleid,  grouprole: vrcgrouproleid});
        }
        this._groupChannels.save();
        this.indexRoles(this._groupChannels[vrcgroupid]);
    }

    unsetGroupRole(vrcgroupid, roleid) {
        if (!this._groupChannels[vrcgroupid]) return;
        let existing = this._groupChannels[vrcgroupid].grouproles.find(assignment => assignment.discordrole == roleid);
        if (existing) {
            this._groupChannels[vrcgroupid].grouproles = this._groupChannels[vrcgroupid].grouproles.filter(assignment => assignment.discordrole != roleid);
            this.unindexRole(roleid, vrcgroupid);
            this._groupChannels.save();
        }
    }

    unsetGroupChannelsAndRoles(vrcgroupid) {
        let channeldata = this._groupChannels[vrcgroupid];
        if (!channeldata) return;
        delete this._groupChannels[vrcgroupid];
        this._groupChannels.save();
        for (let channelid of [channeldata.announcements, channeldata.members, channeldata.greet]) {
            this.unindexChannelsCheck(channelid, {group: vrcgroupid});
        }
        for (let assignment of channeldata.grouproles) {
            this.unindexRole(assignment.discordrole, vrcgroupid);
        }
    }

    setMemberMsg(vrcgroupid, vrcuserid, msgid) {
        if (!vrcgroupid || !this._groupChannels[vrcgroupid]) return false;
        if (msgid) {
            this._groupChannels[vrcgroupid].memberMsgs[vrcuserid] = msgid;
            this._groupChannels.save();
        } else if (this._groupChannels[vrcgroupid].memberMsgs[vrcuserid]) {
            delete this._groupChannels[vrcgroupid].memberMsgs[vrcuserid];
            this._groupChannels.save();
        }
        return true;
    }

    setAnnouncementMsg(vrcgroupid, vrcpostid, msgid) {
        if (!vrcgroupid || !this._groupChannels[vrcgroupid]) return false;
        if (msgid) {
            this._groupChannels[vrcgroupid].announcementMsgs[vrcpostid] = msgid;
            this._groupChannels.save();
        } else if (this._groupChannels[vrcgroupid].announcementMsgs[vrcpostid]) {
            delete this._groupChannels[vrcgroupid].announcementMsgs[vrcpostid];
            this._groupChannels.save();
        }
        return true;
    }


    //Update functions

    async updateGroupMembers(vrcgroupid) {
        if (!this._groups[vrcgroupid].members) {
            this._groups[vrcgroupid].members = [];
        }
        let members = await this.vrchat.vrcGroupMembers(vrcgroupid);
        
        let memberUserIds = members.map(member => member.userId);
        let goneMembers = this._groups[vrcgroupid].members.filter(oldMember => !memberUserIds.includes(oldMember.userId));

        let oldMembers = this._groups[vrcgroupid].members;
        let oldMemberUserIds = oldMembers.map(oldMember => oldMember.userId);
        let newMembers = members.filter(member => !oldMemberUserIds.includes(member.userId));
        let stayingMembers = members.filter(member => oldMemberUserIds.includes(member.userId));

        this._groups[vrcgroupid].members = members;
        this._groups.save();

        let groupname = this._groups[vrcgroupid].name;

        let membershipRoleIds = this.getRolesByGroupRole(vrcgroupid, true) || [];

        //Update members in members channel and discord role assignments

        let now = moment().unix();

        let knownMemberUserids = {};
        for (let member of newMembers.concat(goneMembers).concat(stayingMembers)) {
            let userid = this.vrchat.getUseridByVrc(member.userId);
            if (!userid) continue;
            knownMemberUserids[member.userId] = userid;
        }

        if (Object.keys(knownMemberUserids).length) {
            try {
                //Prefetch in bulk for efficience
                await this.denv.server.members.fetch(Object.values(knownMemberUserids));
            } catch (e) {
                this.log("warn", "Failed to retrieve users for known " + vrcgroupid + " members: " + JSON.stringify(e));
            }
        }

        //- New members
        for (let member of newMembers) {
            
            let groupRoleIds = member.roleIds.slice();
            groupRoleIds.push(true);  //Faux role for "full membership" assignments
            let roleids = this.getMultipleRolesByGroupRoles(vrcgroupid, groupRoleIds);

            if (roleids.length > 0 && knownMemberUserids[member.userId]) {
                this.dqueue(function() {
                    let discordmember = this.denv.server.members.cache.get(knownMemberUserids[member.userId]);
                    try {
                        discordmember.roles.add(roleids, "Role assignments from VRChat group " + groupname);
                    } catch (e) {
                        this.log("warn", "Failed to add roles to new " + vrcgroupid + " member " + member.userId + ": " + JSON.stringify(e));
                    }
                }.bind(this));
            }
        }

        //- Staying (not new) members
        for (let member of stayingMembers) {
            if (!knownMemberUserids[member.userId]) continue;
            let oldmember = oldMembers.find(check => check.userId == member.userId);
            if (!oldmember) continue;  //Should never happen

            let gainedGroupRoleIds = member.roleIds.filter(roleId => !oldmember.roleIds.includes(roleId));
            let gainedRoleids = this.getMultipleRolesByGroupRoles(vrcgroupid, gainedGroupRoleIds);
            if (gainedRoleids.length > 0) {
                this.dqueue(function() {
                    let discordmember = this.denv.server.members.cache.get(knownMemberUserids[member.userId]);
                    try {
                        discordmember.roles.add(gainedRoleids, "Role assignments from VRChat group " + groupname);
                    } catch (e) {
                        this.log("warn", "Failed to add roles to staying " + vrcgroupid + " member " + member.userId + ": " + JSON.stringify(e));
                    }
                }.bind(this));
            }

            let lostGroupRoleIds = oldmember.roleIds.filter(roleId => !member.roleIds.includes(roleId));
            let lostRoleids = this.getMultipleRolesByGroupRoles(vrcgroupid, lostGroupRoleIds);
            if (lostRoleids.length > 0) {
                this.dqueue(function() {
                    let discordmember = this.denv.server.members.cache.get(knownMemberUserids[member.userId]);
                    try {
                        discordmember.roles.remove(lostRoleids, "Role removals from VRChat group " + groupname);
                    } catch (e) {
                        this.log("warn", "Failed to remove roles from staying " + vrcgroupid + " member " + member.userId + ": " + JSON.stringify(e));
                    }
                }.bind(this));
            }

            //Missing membership roles
            let discordmember = this.denv.server.members.cache.get(knownMemberUserids[member.userId]);
            let existingroleids = discordmember.roles.cache.map(role => role.id);
            let roleids = membershipRoleIds.filter(roleid => !existingroleids.includes(roleid));
            if (roleids.length > 0) {
                this.dqueue(function() {
                    try {
                        discordmember.roles.add(roleids, "Role assignments from existing membership in VRChat group " + groupname);
                    } catch (e) {
                        this.log("warn", "Failed to add roles to staying " + vrcgroupid + " member " + member.userId + ": " + JSON.stringify(e));
                    }
                }.bind(this));
            }

        }

        //- Current members (staying and new)
        for (let member of members) {
            this.dqueue(function() {
                this.bakeMember(vrcgroupid, member.userId, now);
            }.bind(this));
        }

        //- Departed members
        for (let member of goneMembers) {

            this.dqueue(function() {
                this.deleteMemberMessage(vrcgroupid, member.userId);
            }.bind(this));

            let roleids = membershipRoleIds;
            
            if (roleids.length > 0 && knownMemberUserids[member.userId]) {
                this.dqueue(function() {
                    let discordmember = this.denv.server.members.cache.get(knownMemberUserids[member.userId]);
                    try {
                        discordmember.roles.remove(roleids, "Role removals from VRChat group " + groupname);
                    } catch (e) {
                        this.log("warn", "Failed to remove roles from departing " + vrcgroupid + " member " + member.userId + ": " + JSON.stringify(e));
                    }
                }.bind(this));
            }

        }

        //Announce arrivals and departures

        let greetchan = this.groupGreetChan(vrcgroupid);
        if (greetchan) {
            if (goneMembers.length == 1) {
                this.msgToGroupGreet(vrcgroupid, this.param("outemoji") + " **" +  goneMembers[0].user.displayName + "** is no longer in the group **" + groupname + "**.");
            }
            if (goneMembers.length > 1) {
                let names = goneMembers.map(each => each.user.displayName);
                this.msgToGroupGreet(vrcgroupid, this.param("outemoji") + " Are no longer in the group **" + groupname + "**: **" +  names.slice(0, -1).join("**, **") + "** and **" + names[names.length - 1] + "**.");
            }
            if (newMembers.length == 1) {
                this.msgToGroupGreet(vrcgroupid, this.param("inemoji") + " **" +  newMembers[0].user.displayName + "** is now a member of the group **" + groupname + "**.");
            }
            if (newMembers.length > 1) {
                let names = newMembers.map(each => each.user.displayName);
                this.msgToGroupGreet(vrcgroupid, this.param("inemoji") + " Are now members of the group **" + groupname + "**: **" +  names.slice(0, -1).join("**, **") + "** and **" + names[names.length - 1] + "**.");
            }
        }
        
    }

    async updateGroupRoles(vrcgroupid) {
        let grouproles = await this.vrchat.vrcGroupRoles(vrcgroupid);
        
        this._groups[vrcgroupid].roles = grouproles;
        this._groups.save();

        //Delete assignments for removed roles

        let grouproleIds = grouproles.map(vrcgrouprole => vrcgrouprole.id);
        for (let assignment of this._groupChannels[vrcgroupid].grouproles || []) {
            if (!grouproleIds.includes(assignment.grouprole)) {
                this.unsetGroupRole(vrcgroupid, assignment.grouprole);
            }
        }

    }

    async updateGroupAnnouncement(vrcgroupid) {
        let old = this._groups[vrcgroupid].announcement;
        
        let groupannouncement = await this.vrchat.vrcGroupAnnouncement(vrcgroupid);
        if (!groupannouncement?.title) groupannouncement = null;
        this._groups[vrcgroupid].announcement = groupannouncement;
        this._groups.save();

        if (old?.id != groupannouncement?.id) {
            this.toggleAnnouncementsOff(vrcgroupid, groupannouncement?.id ? [groupannouncement.id] : undefined);
        }

        this.bakeAnnouncement(vrcgroupid);
        
    }


    //Channel embeds

    async getMemberMessage(vrcgroupid, vrcuserid) {
        let msgid = this._groupChannels[vrcgroupid]?.memberMsgs?.[vrcuserid];
        if (!msgid) return null;
        let message = null;
        try {
            message = await this.groupMembersChan(vrcgroupid).messages.fetch(msgid);
        } catch (e) {}
        return message;
    }
    
    async getAnnouncementMessage(vrcgroupid, vrcpostid) {
        let msgid = this._groupChannels[vrcgroupid]?.announcementMsgs?.[vrcpostid];
        if (!msgid) return null;
        let message = null;
        try {
            message = await this.groupAnnouncementsChan(vrcgroupid).messages.fetch(msgid);
        } catch (e) {}
        return message;
    }

    async bakeAnnouncement(vrcgroupid, now) {
        let announcementChannel = this.groupAnnouncementsChan(vrcgroupid);
        if (!announcementChannel) return;
        let group = this._groups[vrcgroupid];
        if (!group) return;

        let announcement = group.announcement;
        if (!announcement) return;

        if (now) now = moment.unix(now);
        else now = moment();

        let emb = null, message = await this.getAnnouncementMessage(group.id, announcement.id);
        if (message && message.embeds[0]) {
            emb = EmbedBuilder.from(message.embeds[0]);
        }
        if (!emb) {
            emb = new EmbedBuilder();
        }

        emb.setTitle(announcement.title);
        emb.setDescription(announcement.text || null);
        emb.setThumbnail(announcement.imageUrl);
        emb.setColor(this.param("colannounceactive"));
        emb.setAuthor({name: group.name, url: "https://vrchat.com/home/group/" + group.id, iconURL: group.iconURL || undefined});
        emb.setFooter({text: "Posted " + moment(announcement.createdAt).from(now)});

        try {
            if (message) {
                return await message.edit({embeds: [emb]});
            } else {
                return await announcementChannel.send({embeds: [emb]})
                    .then(newmessage => {
                        this.setAnnouncementMsg(group.id, announcement.id, newmessage.id);
                        return newmessage;
                    });
            }
        } catch (e) {
            this.log("warn", "Failed to bake announcement for group " + group.id + ": " + JSON.stringify(e));
        };
    }

    async toggleAnnouncementsOff(vrcgroupid, except) {
        let announcementChannel = this.groupAnnouncementsChan(vrcgroupid);
        if (!announcementChannel) return;
        let group = this._groups[vrcgroupid];
        if (!group) return;
        
        for (let vrcpostid in this._groupChannels[vrcgroupid].announcementMsgs) {
            if (except && except.includes(vrcpostid)) continue;
            let message = await this.getAnnouncementMessage(group.id, vrcpostid);
            if (!message || !message.embeds[0]) continue;
            let emb = EmbedBuilder.from(message.embeds[0]);
            if (this.makeHexColor(emb.data.color) != this.makeHexColor(this.param("colannounceold"))) {
                emb.setColor(this.param("colannounceold"));
                emb.setFooter({text: "Removed " + moment().format("Y-MM-DD HH:mm")});
                this.dqueue(function() {
                    message.edit({embeds: [emb]})
                        .catch((e) => { 
                            this.log("warn", "Failed to toggle announcement for group " + vrcgroupid + ": " + JSON.stringify(e));
                        });
                }.bind(this));
            }
        }
    }

    async bakeMember(vrcgroupid, vrcuserid, now) {
        let memberChannel = this.groupMembersChan(vrcgroupid);
        if (!memberChannel) return;
        let group = this._groups[vrcgroupid];
        if (!group) return;

        let member = group.members.find(check => check.userId == vrcuserid);
        if (!member) return;
        
        let person = this.vrchat.getPersonByVrc(vrcuserid);
        let friend = this.vrchat.getFriend(vrcuserid);

        if (now) now = moment.unix(now);
        else now = moment();

        let emb = null, message = await this.getMemberMessage(group.id, member.userId);
        if (message && message.embeds[0]) {
            emb = EmbedBuilder.from(message.embeds[0]);
        }
        if (!emb) {
            emb = new EmbedBuilder();
        }

        emb.setTitle(member.user?.displayName || person?.name || member.userId);
        if (member.user?.thumbnailUrl) {
            emb.setThumbnail(member.user?.thumbnailUrl);
        }

        let color = this.vrchat.param("coloroffline");
        if (!person?.invisible && this.vrchat.isStatusOnline(friend?.status)) {
            if (member.isRepresenting) {
                color = this.param("colrepresenting");
            } else {
                color = this.vrchat.param("coloronline");
            }
        }
        emb.setColor(color);

        let url;
        if (person) {
            let userid = this.vrchat.getUseridByVrc(vrcuserid);
            url = this.vrchat.getPersonMsgURL(userid);
        }
        if (!url) {
            url = "https://vrchat.com/home/user/" + vrcuserid;
        }
        emb.setURL(url);

        emb.setFooter({text: (member.joinedAt ? "Joined " + moment(member.joinedAt).from(now) : "")});

        let body = [];

        if (friend?.statusDescription) body.push("*" + this.stripNormalizedFormatting(friend.statusDescription.trim()) + "*");

        let roles = [];
        for (let vrcroleid of member.roleIds) {
            let vrcrole = group.roles.find(item => item.id == vrcroleid);
            if (!vrcrole) continue;
            roles.push(vrcrole.name);
        }
        if (roles.length > 0) {
            body.push(roles.join(", "));
        }

        emb.setDescription(body.join("\n\n") || null);

        try {
            if (message) {
                return await message.edit({embeds: [emb]});
            } else {
                return await memberChannel.send({embeds: [emb]})
                    .then(newmessage => {
                        this.setMemberMsg(group.id, member.userId, newmessage.id);
                        return newmessage;
                    });
            }
        } catch (e) {
            this.log("warn", "Failed to bake member " + vrcuserid + " for group " + group.id + ": " + JSON.stringify(e));
        };
    }

    async toggleMembersOff(vrcgroupid) {
        let memberChannel = this.groupMembersChan(vrcgroupid);
        if (!memberChannel) return;
        let group = this._groups[vrcgroupid];
        if (!group) return;
        
        for (let vrcuserid in this._groupChannels[vrcgroupid].memberMsgs) {
            let message = await this.getMemberMessage(vrcgroupid, vrcuserid);
            if (!message || !message.embeds[0]) continue;
            let emb = EmbedBuilder.from(message.embeds[0]);
            if (this.makeHexColor(emb.data.color) != this.makeHexColor(this.vrchat.param("coloroffline"))) {
                emb.setColor(this.vrchat.param("coloroffline"));
                this.dqueue(async function () {
                    await message.edit({embeds: [emb]})
                        .catch((e) => { 
                            this.log("warn", "Failed to toggle color for member " + vrcuserid + " of group " + vrcgroupid + ": " + JSON.stringify(e));
                        });
                }.bind(this));
            }
        }
    }

    async deleteMemberMessage(vrcgroupid, vrcuserid) {
        let message = await this.getMemberMessage(vrcgroupid, vrcuserid);
        if (!message) return;
        return message.delete()
            .catch((e) => { 
                this.log("warn", "Failed to delete member " + vrcuserid + " message for group " + vrcgroupid + ": " + JSON.stringify(e));
            });
    }


    //Helpers

    dqueue(func) {
        this._dqueue.push(func);
    }

    groupAnnouncementsChan(vrcgroupid) {
        if (!this._groupChannels[vrcgroupid]?.announcements) return null;
        return this.denv.server.channels.cache.get(this._groupChannels[vrcgroupid].announcements);
    }

    groupMembersChan(vrcgroupid) {
        if (!this._groupChannels[vrcgroupid]?.members) return null;
        return this.denv.server.channels.cache.get(this._groupChannels[vrcgroupid].members);
    }

    groupGreetChan(vrcgroupid) {
        if (!this._groupChannels[vrcgroupid]?.greet) return null;
        return this.denv.server.channels.cache.get(this._groupChannels[vrcgroupid].greet);
    }

    msgToGroupGreet(vrcgroupid, msg) {
        let achan = this.groupGreetChan(vrcgroupid);
        if (!achan || !msg) return false;
        this.denv.msg(achan.id, msg);
        return true;
    }

}

module.exports = ModVRChatGroups;