import events from 'events'

import Promise from 'bluebird'

import logger from '../../../../util/logger.js'
import wire from '../../../../wire/index.js'
import wireutil from '../../../../wire/util.js'
import grouputil from '../../../../util/grouputil.js'
import lifecycle from '../../../../util/lifecycle.js'
import type {AutoGroupMessage, OwnerMessage} from '../../../../types/wire.js'
import type {
  Channels
, GroupPlugin
, Router
, SoloPlugin
, ZmqSocket
} from '../../../../types/device-plugins.js'

export interface GroupCoreOptions {
  serial: string
  groupTimeout: number
}

// Platform-neutral group (reservation) handling shared by the Android and
// iOS device workers. Platform specific work on join and leave hooks into
// the returned plugin's 'join' and 'leave' events.
export function createGroupPlugin(
  options: GroupCoreOptions
, solo: SoloPlugin
, ident: object
, router: Router
, push: ZmqSocket
, sub: ZmqSocket
, channels: Channels
, logTag: string
): GroupPlugin {
  var log = logger.createLogger(logTag)
  var currentGroup: OwnerMessage | null = null
  var plugin = new events.EventEmitter() as GroupPlugin

  plugin.get = Promise.method(function() {
    if (!currentGroup) {
      throw new grouputil.NoGroupError()
    }

    return currentGroup
  })

  plugin.join = function(newGroup: OwnerMessage, timeout, usage, identifier) {
    return plugin.get()
      .then(function() {
        if (currentGroup!.group !== newGroup.group) {
          throw new grouputil.AlreadyGroupedError()
        }

        return currentGroup!
      })
      .catch(grouputil.NoGroupError, function() {
        currentGroup = newGroup

        log.important('Now owned by "%s"', currentGroup.email)
        log.info('Subscribing to group channel "%s"', currentGroup.group)

        channels.register(currentGroup.group, {
          timeout: timeout || options.groupTimeout
        , alias: solo.channel
        })

        sub.subscribe(currentGroup.group)

        push.send([
          wireutil.global
        , wireutil.envelope(new wire.JoinGroupMessage(
            options.serial
          , currentGroup
          , usage
          ))
        ])

        plugin.emit('join', currentGroup, identifier)

        return currentGroup
      })
  }

  plugin.keepalive = function() {
    if (currentGroup) {
      channels.keepalive(currentGroup.group)
    }
  }

  plugin.leave = function(reason) {
    return plugin.get()
      .then(function(group) {
        log.important('No longer owned by "%s" (reason: %s)', group.email, reason)
        log.info('Unsubscribing from group channel "%s"', group.group)

        channels.unregister(group.group)
        sub.unsubscribe(group.group)

        push.send([
          wireutil.global
        , wireutil.envelope(new wire.LeaveGroupMessage(
            options.serial
          , group
          , reason
          ))
        ])

        currentGroup = null
        plugin.emit('leave', group)

        return group
      })
  }

  router
    .on(wire.GroupMessage, function(channel, message) {
      var reply = wireutil.reply(options.serial)
      grouputil.match(
        ident as unknown as Record<string, string | undefined>
      , message.requirements
      )
        .then(function() {
          return plugin.join(message.owner, message.timeout, message.usage)
        })
        .then(function() {
          push.send([
            channel
          , reply.okay()
          ])
        })
        .catch(grouputil.RequirementMismatchError, function(err) {
          push.send([
            channel
          , reply.fail(err.message)
          ])
        })
        .catch(grouputil.AlreadyGroupedError, function(err) {
          push.send([
            channel
          , reply.fail(err.message)
          ])
        })
    })
    .on(wire.AutoGroupMessage, function(channel, message) {
      return plugin.join(
        message.owner
      , (message as AutoGroupMessage & {timeout?: number}).timeout
      , null
      , message.identifier
      )
        .then(function() {
          plugin.emit('autojoin', message.identifier, true)
        })
        .catch(grouputil.AlreadyGroupedError, function() {
          plugin.emit('autojoin', message.identifier, false)
        })
    })
    .on(wire.UngroupMessage, function(channel, message) {
      var reply = wireutil.reply(options.serial)
      grouputil.match(
        ident as unknown as Record<string, string | undefined>
      , message.requirements
      )
        .then(function() {
          return plugin.leave('ungroup_request')
        })
        .then(function() {
          push.send([
            channel
          , reply.okay()
          ])
        })
        .catch(grouputil.NoGroupError, function(err) {
          push.send([
            channel
          , reply.fail(err.message)
          ])
        })
    })

  channels.on('timeout', function(channel) {
    if (currentGroup && channel === currentGroup.group) {
      plugin.leave('automatic_timeout')
    }
  })

  lifecycle.observe(function() {
    return plugin.leave('device_absent')
      .catch(grouputil.NoGroupError, function() {
        return true
      })
  })

  return plugin
}
