//
//  Created by Mingliang Chen on 17/8/4.
//  illuspas[a]gmail.com
//  Copyright (c) 2018 Nodemedia. All rights reserved.
//
const URL = require('url');
const Logger = require('./node_core_logger');
const context = require('./node_core_ctx');
const NodeCoreUtils = require('./node_core_utils');

//
const FlvPacket = {
  //  create
  create: (payload = null, type = 0, time = 0) => {
    return {
      header: {
        length: payload ? payload.length : 0,
        timestamp: time,
        type: type
      },
      payload: payload
    };
  }
};

//  flv session
class NodeFlvSession {
  constructor(config, req, res) {

    this.config = config;

    this.req = req;

    this.res = res;

    this.id = NodeCoreUtils.generateNewSessionID();

    this.ip = this.req.socket.remoteAddress;

    this.playStreamPath = '';

    this.playArgs = null;

    this.isStarting = false;

    this.isPlaying = false;

    this.isIdling = false;
    //  看connect type
    //  如果请求的是ws 类型的
    if (this.req.nmsConnectionType === 'ws') {
      this.res.cork = this.res._socket.cork.bind(this.res._socket);
      this.res.uncork = this.res._socket.uncork.bind(this.res._socket);
      this.res.on('close', this.onReqClose.bind(this));
      this.res.on('error', this.onReqError.bind(this));
      this.res.write = this.res.send;
      this.res.end = this.res.close;
      this.TAG = 'websocket-flv';
    } else {
      //  http flv
      this.res.cork = this.res.socket.cork.bind(this.res.socket);
      this.res.uncork = this.res.socket.uncork.bind(this.res.socket);
      this.req.socket.on('close', this.onReqClose.bind(this));
      this.req.on('error', this.onReqError.bind(this));
      this.TAG = 'http-flv';
    }

    this.numPlayCache = 0;
    //  添加到context session map 里面去。
    context.sessions.set(this.id, this);
  }

  //  run method
  run() {
    let method = this.req.method;

    let urlInfo = URL.parse(this.req.url, true);

    let streamPath = urlInfo.pathname.split('.')[0];

    this.connectCmdObj = { ip: this.ip, method, streamPath, query: urlInfo.query };

    this.connectTime = new Date();

    this.isStarting = true;

    Logger.log(`[${this.TAG} connect] id=${this.id} ip=${this.ip} args=${JSON.stringify(urlInfo.query)}`);

    context.nodeEvent.emit('preConnect', this.id, this.connectCmdObj);

    if (!this.isStarting) {
      this.stop();
      return;
    }
    //  抛出 post connect 事件
    context.nodeEvent.emit('postConnect', this.id, this.connectCmdObj);

    if (method === 'GET') {
      this.playStreamPath = streamPath;
      this.playArgs = urlInfo.query;

      this.onPlay();
    } else {
      this.stop();
    }
  }

  stop() {
    if (this.isStarting) {
      this.isStarting = false;
      let publisherId = context.publishers.get(this.playStreamPath);
      if (publisherId != null) {
        context.sessions.get(publisherId).players.delete(this.id);
        context.nodeEvent.emit('donePlay', this.id, this.playStreamPath, this.playArgs);
      }
      Logger.log(`[${this.TAG} play] Close stream. id=${this.id} streamPath=${this.playStreamPath}`);
      Logger.log(`[${this.TAG} disconnect] id=${this.id}`);
      context.nodeEvent.emit('doneConnect', this.id, this.connectCmdObj);
      this.res.end();
      context.idlePlayers.delete(this.id);
      context.sessions.delete(this.id);
    }
  }

  onReqClose() {
    this.stop();
  }

  onReqError(e) {
    this.stop();
  }

  reject() {
    Logger.log(`[${this.TAG} reject] id=${this.id}`);
    this.stop();
  }

  //
  onPlay() {
    //  抛出 pre play events
    context.nodeEvent.emit('prePlay', this.id, this.playStreamPath, this.playArgs);

    if (!this.isStarting) {
      return;
    }

    if (this.config.auth !== undefined && this.config.auth.play) {
      let results = NodeCoreUtils.verifyAuth(this.playArgs.sign, this.playStreamPath, this.config.auth.secret);
      if (!results) {
        Logger.log(`[${this.TAG} play] Unauthorized. id=${this.id} streamPath=${this.playStreamPath} sign=${this.playArgs.sign}`);
        this.res.statusCode = 403;
        this.res.end();
        return;
      }
    }

    if (!context.publishers.has(this.playStreamPath)) {
      Logger.log(`[${this.TAG} play] Stream not found. id=${this.id} streamPath=${this.playStreamPath} `);
      context.idlePlayers.add(this.id);
      this.isIdling = true;
      return;
    }

    this.onStartPlay();
  }

  // do start play

  onStartPlay() {
    //  获取publisher id
    let publisherId = context.publishers.get(this.playStreamPath);
    //  获取publisher
    let publisher = context.sessions.get(publisherId);

    let players = publisher.players;
    //
    players.add(this.id);

    //send FLV header
    let FLVHeader = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x00, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00]);
    //  是否是第一次接收到音频数据
    if (publisher.isFirstAudioReceived) {
      FLVHeader[4] |= 0b00000100;
    }
    //  是否是第一次接收到视频数据
    if (publisher.isFirstVideoReceived) {
      FLVHeader[4] |= 0b00000001;
    }
    //  发送flv header
    this.res.write(FLVHeader);

    //send Metadata
    if (publisher.metaData != null) {
      // 创建flv meta data tag
      let packet = FlvPacket.create(publisher.metaData, 18);
      //  创建flv tag
      let tag = NodeFlvSession.createFlvTag(packet);
      this.res.write(tag);
    }

    //send aacSequenceHeader
    if (publisher.audioCodec == 10) {
      //  创建flv aac sequence header tag
      let packet = FlvPacket.create(publisher.aacSequenceHeader, 8);
        //  创建flv tag
      let tag = NodeFlvSession.createFlvTag(packet);
      this.res.write(tag);
    }

    //send avcSequenceHeader
    if (publisher.videoCodec == 7 || publisher.videoCodec == 12) {
      //  创建flv avc/hevc sequence header tag
      let packet = FlvPacket.create(publisher.avcSequenceHeader, 9);
      let tag = NodeFlvSession.createFlvTag(packet);
      this.res.write(tag);
    }

    // send gop cache
    if (publisher.flvGopCacheQueue != null) {
      for (let tag of publisher.flvGopCacheQueue) {
        this.res.write(tag);
      }
    }
    //  设置isPlaying
    this.isIdling = false;
    this.isPlaying = true;

    Logger.log(`[${this.TAG} play] Join stream. id=${this.id} streamPath=${this.playStreamPath} `);
    //
    context.nodeEvent.emit('postPlay', this.id, this.playStreamPath, this.playArgs);
  }

  //  create flv tag
  static createFlvTag(packet) {
    //  创建flv tag size
    let PreviousTagSize = 11 + packet.header.length;
    //  创建flv tag buffer
    let tagBuffer = Buffer.alloc(PreviousTagSize + 4);
    //  写入flv tag header
    tagBuffer[0] = packet.header.type;
    //  写入flv tag header length
    tagBuffer.writeUIntBE(packet.header.length, 1, 3);

    tagBuffer[4] = (packet.header.timestamp >> 16) & 0xff;
    tagBuffer[5] = (packet.header.timestamp >> 8) & 0xff;
    tagBuffer[6] = packet.header.timestamp & 0xff;
    tagBuffer[7] = (packet.header.timestamp >> 24) & 0xff;

    tagBuffer.writeUIntBE(0, 8, 3);
    tagBuffer.writeUInt32BE(PreviousTagSize, PreviousTagSize);

    packet.payload.copy(tagBuffer, 11, 0, packet.header.length);
    return tagBuffer;
  }
}

module.exports = NodeFlvSession;
