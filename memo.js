
var _ = require('underscore');

var PA = null;
var mdb = null;

var commandList = [{
    command: "memo",
    func: _memoCmd,
    help: "Sends / Reads memos.",
    dest: "any",
}];
var Memo = null;
var memoId = 0;
function setMain(mains){
	PA = mains;
	mdb = PA.mdb;
	
	PA.client.addListener('message', function (from, to, message, messageObj) {
			checkForMemos(from,to,message,messageObj);
	});
	
	//# id channel ts lastnoticets sender receiver flags read msg deleted
	//# 0  1       2  3            4       5       6    7    8    9
	try {
		var memoSchema = new mdb.Schema({
			 id: Number
			,channel: String
			,ts: Number
			,lastNoticeTs: Number
			,sender: String
			,receiver: String
			,flags: String
			,read: Boolean
			,msg: String
			,deleted: Boolean
		});
		Memo = mdb.mongoose.model('Memo',memoSchema);
	} catch(ex) {
		Memo = mdb.mongoose.model('Memo');
	}
	Memo.findOne({}).sort("-id").exec(function(err,doc){
		if ( doc ) 
			memoId = doc.id;
	});
}
function onReassemble(){

}
exports.commandList = commandList;
exports.setMain = setMain;
exports.onReassemble = onReassemble;

function checkForMemos(from, to, message, messageObj){
	var now = new Date().getTime();
		var tFrame = now - (1000*60*30);
		Memo.find({receiver: from, read: false, lastNoticeTs: {$lt: tFrame} }).exec(function(err,data){
			if ( data && !err && data.length > 0 ){
				PA.client.say(from, "You have -"+data.length+"- new messages! Type '+memo read new' to read them.");
				_.each(data, function(memo){
					memo.lastNoticeTs = now;
					memo.save(function(err,aff){});
				});
			}
			
		});
}



function _memoCmd (from, to, dest, message, messageObj ) {
	switch (message[1].toLowerCase()) {
		case 'write':
		case 'send':{
			if ( message.length <= 3 ) return;
			
			var rec = message[2];
			var msgToSend = message;
			msgToSend.splice(0,3);
			msgToSend = msgToSend.join(" ");
			
			var memo = new Memo( {
				id: ++memoId,
				channel: to,
				ts: new Date().getTime(),
				lastNoticeTs: -1,
				sender: from,
				receiver: rec, 
				flags: 0,
				read: false,
				msg: msgToSend,
				deleted: false
			});
			memo.save(function(err,aff){
				PA.client.say(dest,"Message sent to "+rec);
				return true;});
			break;
		}
		case 'read':{
			var q;
			var op = -1;
			if ( ( message.length >= 3 && message[2].toLowerCase() == 'inbox' ) ){
				q = Memo.find({receiver: from}).sort('-id').limit(5);
				op = 1;
			} else if ( message.length >= 3 && message[2].toLowerCase() == 'new' ) {
				q = Memo.find({receiver: from, read: false}).sort('-id');
				op = 2;
			} else if ( message.length >= 3 && message[2].toLowerCase() == 'outbox' ) {
				q = Memo.find({sender: from, read: false}).sort('-id');
				op = 3;
			} else {
				q = Memo.find({receiver: from, read: false}).sort('-id');
				op = 2;
			}
			
			
			q.exec( function(err, memos){
				if (memos){
					_.each(memos, function( memo ) {
						//if ( memo.read ) return; 
						var date = new Date(memo.ts);
						var dateStr = date.getHours()+":"+date.getMinutes()+":"+date.getSeconds()+" "+date.getFullYear()+"/"+(date.getMonth()+1)+"/"+date.getDate();
						PA.client.say(from, memo.id + "-["+dateStr+"]("+(op!=3?memo.sender:memo.receiver)+"): " + memo.msg);
						if ( op != 3 ){
							memo.read = true;
							memo.save(function(err,d){});
						}
					});
				}
			
			});
			break;
		}
	}

}