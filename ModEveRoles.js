/* Module: EveRoles -- Bunch of automated tasks that grant roles based on eve SeAT. */
var Module = require('./Module.js');
var express = require('express');
const uuidv4 = require('uuid/v4');

//Example URL: https://login.eveonline.com/oauth/authorize/?response_type=code&redirect_uri=http://wyvernia.net:8098&client_id=1370433d1bd74635839322c867a43bc4&state=uniquestate123

class ModEveRoles extends Module {

    get optionalParams() { return [
        'port',   //Port to listen to on the callback
    ]; }

    get requiredParams() { return [
        'callbackAddress',    //Callback url. (Without the /callback)
        'eveSSOClientId',     //Client ID
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

        this.authCodes = {};

        //Initialize the webservice
        var app = express();

        app.get('/callback', function(req, res) {
            res.send("Successfuly received "+ req.query.state);
        });

        app.listen(8098, function() {
           console.log("Eve callback listening.");
        });

        this.mod('Commands').registerCommand(this, 'authme', {
            description: "Authenticate with eve SSO.",
            args: [],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let uuid = uuidv4();
            this.authCodes[uuid] = {
                uuid: uuid,
                discordID: userid,
                time: new Date(),
            };

            ep.priv("Login using the following link: ");
            ep.priv("https://login.eveonline.com/oauth/authorize/?response_type=code&redirect_uri="+this._params['callbackAddress']+"/callback&client_id="+this._params['eveSSOClientId']+"&state="+uuid);

        });

        return true;
    }
    
    
    // # Module code below this line #

}


module.exports = ModEveRoles;
