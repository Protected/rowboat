/* Module: EveRoles -- Bunch of automated tasks that grant roles based on eve SeAT. */
var Module = require('./Module.js');
var express = require('express');
const uuidv4 = require('uuid/v4');
var  request = require('request');
var jf = require('jsonfile');
var fs = require('fs');
var _ = require('lodash');

//Example URL: https://login.eveonline.com/oauth/authorize/?response_type=code&redirect_uri=http://wyvernia.net:8098&client_id=1370433d1bd74635839322c867a43bc4&state=uniquestate123

const userDataFilename = "userData.json";
const corpContactsDataFilename = "corpContactsData.json";

class ModEveRoles extends Module {

    get optionalParams() { return [
        'port',   //Port to listen to on the callback
        'allianceID',
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

        setInterval(runTick,5000);

        let self = this;

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
            for( let discordId in self.userAssoc ){
                self.processUser(discordId);
            }
        }

        app.get('/callback', function(req, res) {
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
                    let parsedBody = JSON.parse(body);
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
                        let parsedBody = JSON.parse(body);
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
                            let parsedBody = JSON.parse(body);
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
                                    let parsedBody = JSON.parse(body);
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
        });

        app.get('/corpCallback', function(req, res) {
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

                    let parsedBody = JSON.parse(body);
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
                        let parsedBody = JSON.parse(body);
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
                            let parsedBody = JSON.parse(body);
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

        });

        app.listen(8098, function() {
           console.log("Eve callback listening.");
        });

        this.mod("Commands").registerRootDetails(this, 'eve', {description: 'Eve commands.'});

        this.mod('Commands').registerCommand(this, 'eve auth', {
            description: "Authenticate with eve SSO.",
            args: [],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let uuid = uuidv4();
            this.authCodes[uuid] = {
                uuid: uuid,
                discordID: userid,
                time: new Date(),
                envName: env.name
            };
            if ( this.userAssoc[userid] ){
                ep.priv("You are already associated with the character " + this.userAssoc[userid].characterName);
                return true;
            }
            ep.priv("Login using the following link: ");
            ep.priv("https://login.eveonline.com/oauth/authorize/?response_type=code&redirect_uri="+this._params['callbackAddress']+"/callback&client_id="+this._params['eveSSOClientId']+"&state="+uuid);

            return true;
        });

        this.mod('Commands').registerCommand(this, 'eve unlink', {
            description: "Unlink the eve character associated with your discord account.",
            args: [],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let uuid = uuidv4();
            this.authCodes[uuid] = {
                uuid: uuid,
                discordID: userid,
                time: new Date(),
                envName: env.name
            };

            if ( !this.userAssoc[userid] ){
                ep.priv("You have no character associated with you.");
                return true;
            }

            this.applyTagsOnUser(userid,null,null);
            delete this.userAssoc[userid];
            self.saveUserInfo();

            ep.priv("You have unlinked your eve character.");

            return true;
        });

        this.mod('Commands').registerCommand(this, 'eve reload', {
            description: "Reloads the corporation information from eve api.",
            args: [],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let uuid = uuidv4();
            this.authCodes[uuid] = {
                uuid: uuid,
                discordID: userid,
                time: new Date(),
                envName: env.name
            };
            var member = env.server.members.get(userid);
            let role = member.roles.find('name', this._params['adminPermissionName']);

            if ( !role ) {
                ep.priv("You do not have permission to run this command.");
                return true;
            }

            ep.priv("Login using the following link: ");
            ep.priv("https://login.eveonline.com/oauth/authorize/?response_type=code&redirect_uri="+this._params['callbackAddress']+"/corpCallback&client_id="+this._params['eveSSOCorpClientId']+"&state="+uuid+"&scope=esi-corporations.read_contacts.v1");

            return true;
        });

        return true;
    }



    processUser(discordId){

        let userInfo = this.userAssoc[discordId];

        if ( !userInfo ) return;

        if ( this._params['corporationIDList'] && this._params['corporationIDList'].includes(userInfo.corporationID) ){
            this.applyTagsOnUser(discordId, this._params['corpPrefix'], this._params['corpPermissionName'] );
            return;
        }

        if ( this._params['allianceID'] && userInfo.allianceID == this._params['allianceID'] ) {
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

    applyTagsOnUser(discordId, tagText, permissionName){
        let userData = this.userAssoc[discordId];

        let ticker = userData.allianceTicker && this._params['preferAllianceTicker'] ? userData.allianceTicker : userData.corpTicker;

        let member = this.env(userData.envName).server.members.get(discordId);
        if ( tagText ) {
            member.setNickname("["+tagText+"]["+ticker+"] " + userData.characterName, "EveRoles automatic change.").then(success).catch(error);
        } else {
            member.setNickname("["+ticker+"] "+userData.characterName, "EveRoles automatic change.").then(success).catch(error);
        }

        let roles = this.env(userData.envName).server.roles;
        let rolesToRemove = [];
        for(let role of roles){
            if ( !role.name == permissionName && this.relationPermissionNames.includes(role.name) ){
                rolesToRemove.push(role);
            }
        }
        member.removeRoles(rolesToRemove, "EveRoles automatic change.");

        if (permissionName){
            let role = roles.find('name',permissionName);
            member.addRole(role, "EveRoles automatic change.").then(success).catch(error);
        }

        function success(msg){
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

    // # Module code below this line #

}


module.exports = ModEveRoles;
