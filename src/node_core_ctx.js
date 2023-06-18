//
//  Created by Mingliang Chen on 18/3/2.
//  illuspas[a]gmail.com
//  Copyright (c) 2018 Nodemedia. All rights reserved.
//
const EventEmitter = require('events');

let sessions = new Map();
let publishers = new Map();
let idlePlayers = new Set();
//  主要使用 event emitter 来处理事件
let nodeEvent = new EventEmitter();
let stat = {
    inbytes: 0,
    outbytes: 0,
    accepted: 0
};

// global variables for WSA
// 全局变量
module.exports = {
    sessions,
    publishers,
    idlePlayers,
    nodeEvent,
    stat
};