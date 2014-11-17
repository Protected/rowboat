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
				if ( !checkForPermission(from,messageObj.host,commandObj.permission) ){
					client.say(from,"Access denied. Flag "+commandObj.permission+" is required.");
					return;
				}
				if (  commandObj.minParams && messageArr.length < commandObj.minParams+1 ){
					C.getCommand("help").func(from,to,['+help',commandStr],messageObj);
                    return;
				}

				commandObj.func(from,to,messageArr,messageObj);
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

function checkForPermission( nick, vhost, permission ){
	if ( users.length == 0 ) return true;
	if (typeof permission === 'undefined') return true;
	var user = _.find(users, function(user){ return user.nick.toLowerCase() == nick.toLowerCase();});
	if ( !user ) return false;
	if ( user.host.match( new RegExp(vhost)) && ( user.permissions.indexOf(permission) > -1 || user.permissions.indexOf('z') > -1 ) ) return true;
	return false;
}


