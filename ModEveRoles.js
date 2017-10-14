/* Module: EveRoles -- Bunch of automated tasks that grant roles based on eve SeAT. */
var Module = require('./Module.js');
var express = require('express');

//Example URL: https://login.eveonline.com/oauth/authorize/?response_type=code&redirect_uri=http://wyvernia.net:8098&client_id=1370433d1bd74635839322c867a43bc4&state=uniquestate123

class ModEveRoles extends Module {

    /*get optionalParams() { return [
        'delayBetween',         //Delay between pings, not including rtt
        'maxDuration',          //Duration before autostop
        'scrollUp'              //Amount of new messages in channel before autostop
    ]; }*/

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

        //Initialize the webservice
        var app = express();

        app.get('/callback', function(req, res) {
            res.send("Successfuly received "+ req.query.state);
        });

        app.listen(8098, function() {
           console.log("Eve callback listening.");
        });

        return true;
    }
    
    
    // # Module code below this line #

}


module.exports = ModEveRoles;
