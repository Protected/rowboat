/* Module: EveRoles -- Bunch of automated tasks that grant roles based on eve SeAT. */
var Module = require('./Module.js');
var express = require('express');
const uuidv4 = require('uuid/v4');
var  request = require('request');
var jf = require('jsonfile');
var fs = require('fs');
var _ = require('lodash');

var logger = require('logger').createLogger();

logger.setLevel('debug');

//Example URL: https://login.eveonline.com/oauth/authorize/?response_type=code&redirect_uri=http://wyvernia.net:8098&client_id=1370433d1bd74635839322c867a43bc4&state=uniquestate123

const userDataFilename = "userData.json";
const corpContactsDataFilename = "corpContactsData.json";

class ModEveRoles extends Module {

    get optionalParams() { return [
        'port',   //Port to listen to on the callback
        'allianceIDList',
        'corpPrefix',
        'corpPermissionName',
        'alliancePrefix',
        'alliancePermissionName',
        'trueBluePrefix',
        'trueBluePermissionName',
        'bluePrefix',
        'bluePermissionName',
        'orangePrefix',
        'orangePermissionName',
        'redPrefix',
        'redPermissionName',
        'neutPrefix',
        'neutPermissionName',
        'preferAllianceTicker'
    ]; }

    get requiredParams() { return [
        'discordEnvName',      //Environment name of the discord instance to use.
        'callbackAddress',    //Callback url. (Without the /callback)
        'eveSSOClientId',     //Client ID
        'eveSSOEncodedClientIDAndSecretKey', //ClientID and SecretKey encoded with Base64 in this format: clientid:secretkey,
        'eveSSOCorpClientId',     //Corp Client ID
        'eveSSOEncodedCorpClientIDAndSecretKey', //ClientID and SecretKey encoded with Base64 in this format: clientid:secretkey
        'adminPermissionName',    // Discord permission name that admins need to have to run the command.
        'contactsCorporationID',          // ID of the corporation with the contacts.
        'corporationIDList'               //IDs of the corporations to be considered "main".
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('EveRoles', name);
    }

    initialize(opt) {
        if (!super.initialize(opt)) return false;

        let config;
        try {
            config = jf.readFileSync("config/config.json");
        } catch (e) {
            return false;
        }

        this.dataPath = "data/";
        if (config.paths && config.paths.data) {
            this.dataPath = config.paths.data;
        }

        this.authCodes = {};
        this.userAssoc = {};

        this.loadCorpContacts();
        this.loadUserInfo();

        let self = this;

        this.env(this._params['discordEnvName']).on('connected', () => {
            self.mainEnv = self.env(this._params['discordEnvName']);
            runTick();
            checkKills();
        });

        this.neutPermissionName = this._params['neutPermissionName'];
        this.redPermissionName = this._params['redPermissionName'];
        this.orangePermissionName = this._params['orangePermissionName'];
        this.bluePermissionName = this._params['bluePermissionName'];
        this.trueBluePermissionName = this._params['trueBluePermissionName'];
        this.corpPermissionName = this._params['corpPermissionName'];
        this.alliancePermissionName = this._params['alliancePermissionName'];

        this.relationPermissionNames=[this.neutPermissionName, this.redPermissionName, this.orangePermissionName, this.bluePermissionName, this.trueBluePermissionName, this.corpPermissionName, this.alliancePermissionName];

        //Initialize the webservice
        let app = express();

        function runTick() {

            for( let member of self.mainEnv.server.members.array() ){
                self.processUser(member.id);
            }

            _.each(self.userAssoc, ua => {
               if ( !ua.lastChecked ) ua.lastChecked = 1;
            });

            let usersToCheck = _.orderBy(self.userAssoc, ua => ua.lastChecked );
            usersToCheck = _.take(usersToCheck,5);

            for( let user of usersToCheck ){
                self.checkUser(user.discordID);
            }

            self.loadUserInfo();
            setTimeout(runTick,15000);
        }

        function checkKills(){
            self.getKills();
            setTimeout(checkKills,100);
        }

        app.get('/callback', (req,res) => {
            return this.authCallback(this,req,res);
        });

        app.get('/corpCallback', (req,res) => {
            return this.corpCallback(this,req,res);
        });

        app.listen(8098, function() {
            logger.info("Eve callback listening.");
        });

        this.mod("Commands").registerRootDetails(this, 'eve', {description: 'Eve commands.'});

        this.mod('Commands').registerCommand(this, 'eve auth', {
            description: "Authenticate with eve SSO.",
            args: [],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            return this.commandEveAuth(this, env, type, userid, channelid, command, args, handle, ep);
        } );

        this.mod('Commands').registerCommand(this, 'eve unlink', {
            description: "Unlink the eve character associated with your discord account.",
            args: [],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            return this.commandEveUnlink(this, env, type, userid, channelid, command, args, handle, ep);
        });

        this.mod('Commands').registerCommand(this, 'eve reload', {
            description: "Reloads the corporation information from eve api.",
            args: [],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            return this.commandEveReload(this, env, type, userid, channelid, command, args, handle, ep);
        });

        this.mod('Commands').registerCommand(this, 'ev', {
            description: "Evaluates and runs expressions.",
            args: ["exp"],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            return this.commandEveEv(this, env, type, userid, channelid, command, args, handle, ep);
        });

        return true;
    }


    getKills(){

        //https://redisq.zkillboard.com/listen.php?queueID=AWRyder
        request.get({
            url: "https://redisq.zkillboard.com/listen.php?queueID=R0WB0ATARCH",
            headers: {
            }
        }, (err, httpResponse, body) => {
            let parsedBody;
            try {
                parsedBody = JSON.parse(body);
            } catch( e ){
                return;
            }

            if ( parsedBody.package == null ) return;

            let pkg = parsedBody.package;
            let victim = pkg.killmail.victim;
            if ( (this._params['corporationIDList'] && this._params['corporationIDList'].includes(victim.corporationID+""))
            ||   (this._params['allianceIDList'] && this._params['allianceIDList'].includes(victim.allianceID+""))
            ||   hasSomeoneInAttackerList(pkg.killmail.attackers) ) {
                this.processKillmail(parsedBody);
            }
        });

        function hasSomeoneInAttackerList(attackers) {
            if ( !attackers || !attackers.length ) return false;
            for( let attacker of attackers ){
                if ( (this._params['corporationIDList'] && this._params['corporationIDList'].includes(attacker.corporationID+""))
                ||   (this._params['allianceIDList'] && this._params['allianceIDList'].includes(attacker.allianceID+"")) ) {
                    return true;
                }
            }
            return false;
        }
    }

    processKillmail(body){
        let pkg = body.package;
        let victim = pkg.killmail.victim;
        let zkb = pkg.zkb;
        let killID = zkb.killID;
        let link = "https://zkillboard.com/kill/"+killID+"/";

        this.mainEnv.server.channels.find('name','kills').send(link).then(message => logger.debug(message)).catch(logger.warn);
    }


    processUser(discordId){

        let userInfo = this.userAssoc[discordId];

        if ( !userInfo ) {
            this.applyTagsOnUser(discordId, null, null, true );
            return;
        }

        if ( this._params['corporationIDList'] && this._params['corporationIDList'].includes(userInfo.corporationID+"") ){
            this.applyTagsOnUser(discordId, this._params['corpPrefix'], this._params['corpPermissionName'] );
            return;
        }

        if ( this._params['allianceIDList'] && this._params['allianceIDList'].includes(userInfo.allianceID+"") ){
            this.applyTagsOnUser(discordId, this._params['alliancePrefix'], this._params['alliancePermissionName'] );
            return;
        } 

        let effectiveStanding = this.determineRelationship(discordId);

        switch(effectiveStanding){
            case 10:  this.applyTagsOnUser(discordId, this._params['trueBluePrefix'], this._params['trueBluePermissionName'] ); break;
            case 5:   this.applyTagsOnUser(discordId, this._params['bluePrefix'], this._params['bluePermissionName'] ); break;
            case -5:  this.applyTagsOnUser(discordId, this._params['orangePrefix'], this._params['orangePermissionName'] ); break;
            case -10: this.applyTagsOnUser(discordId, this._params['redPrefix'], this._params['redPermissionName'] ); break;
            case 0:
            default:  this.applyTagsOnUser(discordId, this._params['neutPrefix'], this._params['neutPermissionName'] ); break;
        }
    }

    applyTagsOnUser(discordId, tagText, permissionName, stripAll){
        let userData = this.userAssoc[discordId];

        let self = this;

        let member = this.mainEnv.server.members.get(discordId);
        if ( !member ) return;

        if ( this.ignoredMembers && this.ignoredMembers[member.id]){
            return;
        }

        if ( member.roles.find('name', this._params['adminPermissionName']) ){
            return;
        }

        if ( userData ) {
            let ticker = userData.allianceTicker && this._params['preferAllianceTicker'] ? userData.allianceTicker : userData.corpTicker;

            if (tagText) {
                this.setName(member, "[" + tagText + "][" + ticker + "] " + userData.characterName);
            } else {
                this.setName(member, "[" + ticker + "] " + userData.characterName);
            }
        } else {
            if (!stripAll) logger.warn("userData is null for "+discordId);
        }


        let roles = this.mainEnv.server.roles;
        let rolesToRemove;
        if ( member.roles.find('name', this._params['adminPermissionName']) ){
            rolesToRemove = roles.filter( r => false);
        } else {
            rolesToRemove = roles.filter(role => {
                return ( role.name != permissionName && (this.relationPermissionNames.includes(role.name) || stripAll) );
            });
        }

        let rolesMemberHasThatNeedRemoving = member.roles.filter( r => rolesToRemove.has(r.id) && r.id != r.guild.id);

        if ( rolesMemberHasThatNeedRemoving && rolesMemberHasThatNeedRemoving.size > 0) {
            logger.debug("Removing "+rolesMemberHasThatNeedRemoving.size+" roles from "+member.displayName);
            member.removeRoles(rolesMemberHasThatNeedRemoving, "EveRoles automatic change.").then(success).catch(error);
        }

        if (permissionName){
            let role = roles.find('name',permissionName);
            if ( ! member.roles.find('name', permissionName) ) {
                logger.debug("Adding role "+role.name+" to "+member.nickname);
                member.addRole(role, "EveRoles automatic change.").then(success).catch(error);
            }
        }

        function success(msg) {

        }

        function error(err) {
            if ( err.code == 50013 ){
                if ( !self.ignoredMembers ) self.ignoredMembers = {};
                self.ignoredMembers[member.id] = true;
                logger.error("Can't change permissions for this user. Ignoring.");
            } else {
                logger.error(err);
            }
        }
    }

    setName(member, nickName){
        if ( member.nickname != nickName && member.displayName != nickName ) {
            logger.debug("Setting name '"+nickName+"' to '"+member.displayName+"'");
            member.setNickname(nickName, "EveRoles automatic change.").then(success).catch(error);
        }
        function success(succ){

        }
        function error(err){

        }
    }



    determineRelationship(discordId){
        let userInfo = this.userAssoc[discordId];
        let charID = userInfo.characterID;
        let corpID = userInfo.corporationID;
        let allianceID = userInfo.allianceID;

        let charStandings = undefined;
        let corpStandings = undefined;
        let allianceStandings = undefined;

        for( let corpContact of this.corpContacts){
            if ( corpContact.contact_type == "character") {
                if (charID == corpContact.contact_id) {
                    charStandings = corpContact.standing;
                }
            } else if ( corpContact.contact_type == "corporation") {
                if (corpID == corpContact.contact_id) {
                    corpStandings = corpContact.standing;
                }
            } else if ( corpContact.contact_type == "alliance") {
                if (allianceID == corpContact.contact_id) {
                    allianceStandings = corpContact.standing;
                }
            }
        }

        if (charStandings) return charStandings;
        if (corpStandings) return corpStandings;
        if (allianceStandings) return allianceStandings;

        return 0;
    }

    checkUser(discordId) {
        let self = this;
        let userData = this.userAssoc[discordId];
        if ( !userData ) return;

        request.get({
            url: "https://esi.tech.ccp.is/latest/characters/"+userData.characterID+"/",
            headers: {
            }
        }, (err, httpResponse, body) => {
            let parsedBody;
            try {
                parsedBody = JSON.parse(body);
            } catch( e ){
                return;
            }
            if ( err || !parsedBody ){
                return;
            }

            let corporationID = parsedBody.corporation_id;
            let allianceID = parsedBody.alliance_id;
            let corpTicker = null;
            let allianceTicker = null;

            request.get({
                url: "https://esi.tech.ccp.is/latest/corporations/"+corporationID+"/",
                headers: {
                }
            }, (err, httpResponse, body) => {
                let parsedBody;
                try {
                    parsedBody = JSON.parse(body);
                } catch( e ){
                    return;
                }
                if (err || !parsedBody || !parsedBody.ticker ) {
                    return;
                }
                corpTicker = parsedBody.ticker;

                if ( allianceID ){
                    request.get({
                        url: "https://esi.tech.ccp.is/latest/alliances/"+allianceID+"/",
                        headers: {
                        }
                    }, (err, httpResponse, body) => {
                        let parsedBody;
                        try {
                            parsedBody = JSON.parse(body);
                        } catch( e ){
                            return;
                        }
                        if (err || !parsedBody || !parsedBody.ticker) {
                            return;
                        }
                        allianceTicker = parsedBody.ticker;

                        finishAuthing();
                    });
                } else {
                    finishAuthing();
                }

                function finishAuthing(){

                    self.userAssoc[discordId].corporationID = corporationID;
                    self.userAssoc[discordId].allianceID = allianceID;
                    self.userAssoc[discordId].corpTicker = corpTicker;
                    self.userAssoc[discordId].allianceTicker = allianceTicker;
                    self.userAssoc[discordId].lastChecked = Date.now();

                    self.saveUserInfo();
                }
            });
        });

    }


    saveUserInfo() {
        let filePath = this.dataPath + userDataFilename;
        jf.writeFileSync(filePath,this.userAssoc);
    }
    loadUserInfo() {
        let filePath = this.dataPath + userDataFilename;
        if (fs.existsSync(filePath)) {
            let ret = jf.readFileSync(filePath);
            if ( ret ) this.userAssoc = ret;
        }
    }
    loadCorpContacts() {
        let filePath = this.dataPath + corpContactsDataFilename;
        if (fs.existsSync(filePath)) {
            let ret = jf.readFileSync(filePath);
            if ( ret ) this.corpContacts = ret;
        }
    }

    // Callbacks

    authCallback(self, req, res) {
        let state = req.query.state;
        let code  = req.query.code;

        let authInfo = self.authCodes[state];

        if ( !authInfo ) {
            res.send("Invalid link");
            return;
        }

        let formData = {
            "grant_type":"authorization_code",
            "code": code
        };

        request.post(
            {
                url:"https://login.eveonline.com/oauth/token",
                formData: formData,
                headers: {
                    "Authorization": "Basic "+self._params['eveSSOEncodedClientIDAndSecretKey'],
                    "Content-Type": "application/json",
                    "Host": "login.eveonline.com"
                }
            }, (err, httpResponse, body) => {
                if ( err ) {
                    res.send("Error validating");
                    return;
                }

                let parsedBody = JSON.parse(body);
                if ( !parsedBody ){
                    res.send("Error validating");
                    return;
                }

                request.get({
                    url: "https://login.eveonline.com/oauth/verify",
                    headers: {
                        "Host": "login.eveonline.com",
                        "Authorization": "Bearer "+parsedBody.access_token,
                    }
                }, (err, httpResponse, body) => {
                    let parsedBody;
                    try {
                        parsedBody = JSON.parse(body);
                    } catch( e ){
                        res.send("Error validating");
                        return;
                    }
                    if ( err || !parsedBody ){
                        res.send("Error validating");
                        return;
                    }
                    let characterID = parsedBody.CharacterID;
                    let characterName = parsedBody.CharacterName;

                    if ( !characterID ) {
                        res.send("Error validating");
                        return;
                    }

                    request.get({
                        url: "https://esi.tech.ccp.is/latest/characters/"+characterID+"/",
                        headers: {
                        }
                    }, (err, httpResponse, body) => {
                        let parsedBody;
                        try {
                            parsedBody = JSON.parse(body);
                        } catch( e ){
                            res.send("Error validating");
                            return;
                        }
                        if ( err || !parsedBody ){
                            res.send("Error retrieving info");
                            return;
                        }

                        let corporationID = parsedBody.corporation_id;
                        let allianceID = parsedBody.alliance_id;
                        let corpTicker = null;
                        let allianceTicker = null;

                        request.get({
                            url: "https://esi.tech.ccp.is/latest/corporations/"+corporationID+"/",
                            headers: {
                            }
                        }, (err, httpResponse, body) => {
                            let parsedBody;
                            try {
                                parsedBody = JSON.parse(body);
                            } catch( e ){
                                res.send("Error validating");
                                return;
                            }
                            if (err || !parsedBody) {
                                res.send("Error retrieving info");
                                return;
                            }
                            corpTicker = parsedBody.ticker;

                            if ( allianceID ){
                                request.get({
                                    url: "https://esi.tech.ccp.is/latest/alliances/"+allianceID+"/",
                                    headers: {
                                    }
                                }, (err, httpResponse, body) => {
                                    let parsedBody;
                                    try {
                                        parsedBody = JSON.parse(body);
                                    } catch( e ){
                                        res.send("Error validating");
                                        return;
                                    }
                                    if (err || !parsedBody) {
                                        res.send("Error retrieving info");
                                        return;
                                    }
                                    allianceTicker = parsedBody.ticker;

                                    finishAuthing();
                                });
                            } else {
                                finishAuthing();
                            }

                            function finishAuthing(){
                                let userInformation = {
                                    discordID: authInfo.discordID,
                                    characterID: characterID,
                                    characterName: characterName,
                                    corporationID: corporationID,
                                    allianceID: allianceID,
                                    corpTicker: corpTicker,
                                    allianceTicker: allianceTicker,
                                    envName: authInfo.envName
                                };

                                self.userAssoc[userInformation.discordID] = userInformation;

                                res.send("Successfully linked to this account. You may close this window now.");
                                self.env(authInfo.envName).msg(authInfo.discordID, "Your discord account associated with the character "+characterName);
                                self.saveUserInfo();
                                delete self.authCodes[state];
                            }
                        });
                    });
                });
            });
    }

    corpCallback(self, req, res) {
        let state = req.query.state;
        let code  = req.query.code;

        let authInfo = self.authCodes[state];

        if ( !authInfo ) {
            res.send("Invalid link");
            return;
        }

        let formData = {
            "grant_type":"authorization_code",
            "code": code
        };

        request.post(
            {
                url:"https://login.eveonline.com/oauth/token",
                formData: formData,
                headers: {
                    "Authorization": "Basic "+self._params['eveSSOEncodedCorpClientIDAndSecretKey'],
                    "Content-Type": "application/json",
                    "Host": "login.eveonline.com"
                }
            }, (err, httpResponse, body) => {
                if (err) {
                    res.send("Error validating");
                    return;
                }

                let parsedBody;
                try {
                    parsedBody = JSON.parse(body);
                } catch( e ){
                    res.send("Error validating");
                    return;
                }
                if (!parsedBody) {
                    res.send("Error validating");
                    return;
                }

                let accessToken = parsedBody.access_token;

                request.get({
                    url: "https://login.eveonline.com/oauth/verify",
                    headers: {
                        "Host": "login.eveonline.com",
                        "Authorization": "Bearer "+parsedBody.access_token,
                    }
                }, (err, httpResponse, body) => {
                    let parsedBody;
                    try {
                        parsedBody = JSON.parse(body);
                    } catch( e ){
                        res.send("Error validating");
                        return;
                    }
                    if ( err || !parsedBody ){
                        res.send("Error validating");
                        return;
                    }

                    request.get({
                        url: "https://esi.tech.ccp.is/latest/corporations/"+self._params['contactsCorporationID']+"/contacts/",
                        headers: {
                            "Authorization": "Bearer "+accessToken,
                        }
                    }, (err, httpResponse, body) => {
                        let parsedBody;
                        try {
                            parsedBody = JSON.parse(body);
                        } catch( e ){
                            res.send("Error validating");
                            return;
                        }
                        if ( err || !parsedBody ){
                            res.send("Error retrieving info");
                            return;
                        }

                        if ( !_.isArray(parsedBody) ){
                            res.send("Error updating corporation info: "+body);
                            return;
                        }

                        self.corpContacts = parsedBody;
                        let filePath = self.dataPath + corpContactsDataFilename;
                        jf.writeFileSync(filePath,self.corpContacts);

                        res.send("Successfully refreshed corporation information. You may close this window now.");
                        self.env(authInfo.envName).msg(authInfo.discordID, "Your corporation information has been refreshed.");

                    });
                });
            });

    }

    // Commands

    commandEveAuth(scope, env, type, userid, channelid, command, args, handle, ep) {

        let uuid = uuidv4();
        scope.authCodes[uuid] = {
            uuid: uuid,
            discordID: userid,
            time: new Date(),
            envName: env.name
        };
        if (scope.userAssoc[userid]) {
            ep.priv("You are already associated with the character " + scope.userAssoc[userid].characterName);
            return true;
        }
        ep.priv("Login using the following link: ");
        ep.priv("https://login.eveonline.com/oauth/authorize/?response_type=code&redirect_uri=" + scope._params['callbackAddress'] + "/callback&client_id=" + scope._params['eveSSOClientId'] + "&state=" + uuid);

        return true;
    }

    commandEveUnlink(scope, env, type, userid, channelid, command, args, handle, ep) {
        let uuid = uuidv4();
        scope.authCodes[uuid] = {
            uuid: uuid,
            discordID: userid,
            time: new Date(),
            envName: env.name
        };

        if (!scope.userAssoc[userid]) {
            ep.priv("You have no character associated with you.");
            return true;
        }

        scope.applyTagsOnUser(userid, null, null, true);
        delete scope.userAssoc[userid];
        scope.saveUserInfo();

        ep.priv("You have unlinked your eve character.");

        return true;
    }

    commandEveReload(scope, env, type, userid, channelid, command, args, handle, ep) {

        let uuid = uuidv4();
        scope.authCodes[uuid] = {
            uuid: uuid,
            discordID: userid,
            time: new Date(),
            envName: env.name
        };
        var member = env.server.members.get(userid);
        let role = member.roles.find('name', scope._params['adminPermissionName']);

        if (!role) {
            ep.priv("You do not have permission to run this command.");
            return true;
        }

        ep.priv("Login using the following link: ");
        ep.priv("https://login.eveonline.com/oauth/authorize/?response_type=code&redirect_uri=" + scope._params['callbackAddress'] + "/corpCallback&client_id=" + scope._params['eveSSOCorpClientId'] + "&state=" + uuid + "&scope=esi-corporations.read_contacts.v1");

        return true;
    }

    commandEveEv(scope, env, type, userid, channelid, command, args, handle, ep) {
        if (userid != "133647011424501761") {
            ep.reply("Not allowed! Dangerous alchemy.");
            return true;
        }
        //ep.reply(args.exp);
        try {
            let result = eval(args.exp);
            ep.reply(result);
        } catch (ex){
            ep.reply(ex.message);
        }
        return true;
    }

}


module.exports = ModEveRoles;
