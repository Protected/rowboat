var irc = require('irc');
var _ = require('underscore');
var C = require('./Commands.js');
var jf = require('jsonfile');
var fs = require('fs');
var argv = require('yargs')
          .default('server','irc.irchighway.net')
          .default('nick','Praecantatio')
          .default('channel','#empire')
          .default('nickserv-passwd',null)
          .argv
		  ;

var client = new irc.Client(argv.server, argv.nick, {
    channels: [argv.channel],
	userName: 'Prae',
	realName: 'Praecantatio',
	floodProtection: true,
	floodProtectionDelay: 500,
	stripColors: true
});
var users = [];
var channelSettings = [{
	network: 'irc.irchighway.net',
	channels: [
		{
			name: "#empire",
			commands: [
				{
					name:"duel",
					restrict:"@"
				}
			]
		}
	]
}];

//Public Access Object
var PAObj = {
	client: client,
	checkForPermission: checkForPermission,
	users: users
};


C.setMain(PAObj);

client.addListener('error', function(message) {
    console.log('error: ', message);
});

/*//DEBUG
client.addListener('raw', function ( messageObj) {
	console.log(JSON.stringify(messageObj));
});
//*///

//Commands
client.addListener('message', function (from, to, message, messageObj) {
    
    if ( message.charAt(0) == '+' ) {
		var messageArr = message.split(" ");
		var commandStr = messageArr[0].substring(1);
		
		if ( commandStr == "reassemble" && checkForPermission(from,messageObj.host,'z') ){
			console.log(from + ' reassembled me!');
			C = requireUncached('./Commands.js');
			C.setMain(PAObj);
			client.say(from,"Reassembled!");
			return;
		}
		
		var commandObj = C.getCommand(commandStr);
		if ( commandObj ){
			try {
				var dest;
				if ( !checkForPermission(from,messageObj.host,commandObj.permission) ){
					client.notice(from,"Access denied. Flag "+commandObj.permission+" is required.");
					return;
				}
				if (  commandObj.minParams && messageArr.length < commandObj.minParams+1 ){
					C.getCommand("help").func(from,to,from,['+help',commandStr],messageObj);
                    return;
				}

				if ( commandObj.dest ){
					switch (commandObj.dest){
						case "source": dest = from; break;
						case "channel": {
							if ( to.charAt(0)=='#' ){
								dest = to;
								break;
							}
							else {
								client.notice(from,"Can't use this command outside a channel.");
								return;
							}
						}
						case "any":
						default: dest = to.charAt(0)=='#'?to:from; break;
					}
				} else {
					dest = to.charAt(0)=='#'?to:from;
				}
				/*
				if ( dest==to && !checkForRestrictions(dest,from,commandStr )) {
					client.notice(dest,"Access denied. Restricted by the channel admin.");
					return;
				}*/
				commandObj.func(from,to,dest,messageArr,messageObj);
				//if ( message.length < 2 ) { _helpCmd(from, to, ["+help","names"]); return; }
			}catch(ex){
				console.log(ex);
			}
		}
    }

});

//Reload
function requireUncached(module){
    delete require.cache[require.resolve(module)]
    return require(module)
}
//RemoveUserFromChannelList
function removeUser(channel, nick){
	var c = _.find(channels, function(c){
		return c.name == channel;
	});
	if ( !c ) return;
	delete c.users[nick];
}

//AllowedList
/*
		nick: "AWRyder",
		host: "doesnt.care.about.vhosts",
		permissions: "z"
*/
jf.readFile('users.json', function(err, obj){
	if ( obj ){
		users = obj;
		PAObj.users = users;
	}
});

function compareChannelLevels(l1, l2){
	var values = {
		"~" : 20,
		"&" : 15,
		"!" : 10,
		"@" : 5,
		"%" : 4,
		"+" : 3
	};

	var ll1 = l1;
	var y = 0;
	for ( var i=0; i<ll1.length; i++ ){
		var x = 0;
		try {
			x = values[ll1[i]];
		} catch( e ){
			x = 0;
		}
		if ( x > y ) {
			l1 = ll1[i];
			y = x;
		}
	}
	
	var v1;
	try {
		v1 = values[l1];
	} catch( e ){
		v1 = 0;
	}
	var v2;
	try {
		v2 = values[l2];
	} catch( e ){
		v2 = 0;
	}

	return v1 >= v2;
}

function checkForPermission( nick, vhost, permission ){
	if ( users.length == 0 ) return true;
	if (typeof permission === 'undefined') return true;
	var user = _.find(users, function(user){ return user.nick.toLowerCase() == nick.toLowerCase();});
	if ( !user ) return false;
	if ( user.host.match( new RegExp(vhost)) && ( user.permissions.indexOf(permission) > -1 || user.permissions.indexOf('z') > -1 ) ) return true;
	return false;
}

function checkForRestrictions( channel, nick, command  ){
	var c = _.find(Object.keys(client.chans), function(c) {
		return c == channel;
	});
	c = client.chans[c];

	if ( !c ) {
		return false;
	} else {
		var perm = c.users[nick];
		
		var cs = _.find(channelSettings, function(cs){
			return cs.network == argv.server;
		});

		var csChan = _.find(cs.channels,function(csChan){
			return csChan.name == channel;
		});

		var csChanCommand = _.find(csChan.commands, function(csChanCommand){
			return csChanCommand.name == command;
		});

		if ( !csChanCommand ) return true;
		
		if ( compareChannelLevels(perm, csChanCommand.restrict) ) return true;
		return false;
	}

}


