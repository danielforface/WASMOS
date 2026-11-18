// One isolated reactor instance per authorized origin/peer. The embedding
// application supplies UDP packets; no browser networking API is imported.
package main

import (
	"context"
	"encoding/json"
	"errors"
	wire "github.com/danielforface/WASMOS/transport"
	"github.com/danielforface/WASMOS/trust"
	"github.com/pion/webrtc/v4"
	wt "github.com/quic-go/webtransport-go"
	"io"
	"net/netip"
	"runtime"
	"sync"
	"time"
	"unsafe"
)

const bufCap = 96 * 1024
const maxHandles = 32

var buf [bufCap]byte
var port *wire.Port
var peer *wire.Peer
var session *wt.Session
var ctx, cancel = context.WithCancel(context.Background())
var events = make(chan []byte, 64)
var mode string
var mu sync.Mutex
var next int
var channels = map[int]*webrtc.DataChannel{}
var streams = map[int]*wt.Stream{}
var pending int

type Command struct {
	Op, Local, Remote, URL, Origin, SDP, Label string
	ID                                         int
	Data                                       []byte
}
type Event struct {
	Type string `json:"type"`
	ID   int    `json:"id,omitempty"`
	Text string `json:"text,omitempty"`
	Data []byte `json:"data,omitempty"`
}

func emit(typ string, id int, text string, data []byte) {
	b, e := json.Marshal(Event{typ, id, text, data})
	if e != nil || len(b) > bufCap {
		cancel()
		return
	}
	select {
	case events <- b:
	default:
		cancel()
	} // overflow is terminal; never grow an unbounded queue
}
func failure(e error) {
	if e != nil {
		emit("error", 0, e.Error(), nil)
	}
}
func registerDC(dc *webrtc.DataChannel) {
	mu.Lock()
	if len(channels) >= maxHandles {
		mu.Unlock()
		dc.Close()
		return
	}
	next++
	id := next
	channels[id] = dc
	mu.Unlock()
	dc.OnOpen(func() { emit("channel", id, dc.Label(), nil) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if len(m.Data) > 48*1024 {
			dc.Close()
			return
		}
		emit("message", id, "", m.Data)
	})
	dc.OnClose(func() { mu.Lock(); delete(channels, id); mu.Unlock(); emit("channel-close", id, "", nil) })
}
func attach(s *wt.Stream) {
	mu.Lock()
	if len(streams) >= maxHandles {
		mu.Unlock()
		s.CancelRead(0)
		s.CancelWrite(0)
		return
	}
	next++
	id := next
	streams[id] = s
	mu.Unlock()
	emit("stream", id, "", nil)
	go func() {
		b := make([]byte, 16*1024)
		for {
			n, e := s.Read(b)
			if n > 0 {
				emit("stream-data", id, "", b[:n])
			}
			if e != nil {
				if e != io.EOF {
					failure(e)
				}
				emit("stream-end", id, "", nil)
				return
			}
		}
	}()
}
func async(fn func() error) bool {
	mu.Lock()
	if pending >= maxHandles {
		mu.Unlock()
		return false
	}
	pending++
	mu.Unlock()
	go func() { defer func() { mu.Lock(); pending--; mu.Unlock() }(); failure(fn()) }()
	return true
}
func start(c Command) error {
	if port != nil {
		return errors.New("one session per instance")
	}
	l, e := netip.ParseAddrPort(c.Local)
	if e != nil {
		return e
	}
	r, e := netip.ParseAddrPort(c.Remote)
	if e != nil {
		return e
	}
	p, e := wire.NewPort(l, r)
	if e != nil {
		return e
	}
	port = p
	mode = c.Op
	if mode == "rtc" {
		peer, e = wire.NewPeer(p)
		if e != nil {
			p.Close()
			return e
		}
		peer.OnDataChannel(registerDC)
		peer.OnConnectionStateChange(func(state webrtc.PeerConnectionState) { emit("rtc-state", 0, state.String(), nil) })
		return nil
	}
	roots, deny, e := trust.Profile()
	if e != nil {
		p.Close()
		return e
	}
	go func() {
		dctx, stop := context.WithTimeout(ctx, wire.HandshakeTimeout)
		defer stop()
		s, e := wire.DialWebTransport(dctx, p, p.PeerAddr(), c.URL, c.Origin, roots, deny)
		if e != nil {
			failure(e)
			return
		}
		session = s
		emit("ready", 0, "webtransport", nil)
		go func() {
			for {
				st, e := s.AcceptStream(ctx)
				if e != nil {
					return
				}
				attach(st)
			}
		}()
		for {
			b, e := s.ReceiveDatagram(ctx)
			if e != nil {
				emit("session-close", 0, e.Error(), nil)
				return
			}
			emit("datagram", 0, "", b)
		}
	}()
	return nil
}

//go:wasmexport buffer
func buffer() uint32 { return uint32(uintptr(unsafe.Pointer(&buf[0]))) }

//go:wasmexport capacity
func capacity() uint32 { return bufCap }

//go:wasmexport step
func step() {
	for i := 0; i < 8; i++ {
		runtime.Gosched()
	}
}

//go:wasmexport command
func command(n uint32) int32 {
	if n > bufCap || ctx.Err() != nil {
		return -1
	}
	var c Command
	if json.Unmarshal(buf[:n], &c) != nil {
		return -2
	}
	var e error
	switch c.Op {
	case "rtc", "webtransport":
		e = start(c)
	case "channel":
		if peer == nil || len(c.Label) > 256 || len(channels) >= maxHandles {
			return -3
		}
		var d *webrtc.DataChannel
		d, e = peer.CreateDataChannel(c.Label, nil)
		if e == nil {
			registerDC(d)
		}
	case "offer", "answer":
		if peer == nil {
			return -3
		}
		if !async(func() error {
			dctx, stop := context.WithTimeout(ctx, wire.HandshakeTimeout)
			defer stop()
			if c.Op == "answer" {
				if e := peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: c.SDP}); e != nil {
					return e
				}
			}
			s, e := peer.Gather(dctx, c.Op == "offer")
			if e == nil {
				emit(c.Op, 0, s.SDP, nil)
			}
			return e
		}) {
			return -4
		}
	case "accept-answer":
		if peer == nil {
			return -3
		}
		e = peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: c.SDP})
	case "message":
		d := channels[c.ID]
		if d == nil || len(c.Data) > 48*1024 || d.BufferedAmount() > 256*1024 {
			return -3
		}
		e = d.Send(c.Data)
	case "datagram":
		if session == nil {
			return -3
		}
		e = session.SendDatagram(c.Data)
	case "stream":
		if session == nil || len(streams) >= maxHandles {
			return -3
		}
		var s *wt.Stream
		s, e = session.OpenStream()
		if e == nil {
			attach(s)
		}
	case "write", "finish", "release":
		s := streams[c.ID]
		if s == nil {
			return -3
		}
		if c.Op == "release" {
			s.CancelRead(0)
			s.CancelWrite(0)
			delete(streams, c.ID)
			return 0
		}
		if !async(func() error {
			if c.Op == "finish" {
				return s.Close()
			}
			s.SetWriteDeadline(time.Now().Add(wire.HandshakeTimeout))
			_, e := s.Write(c.Data)
			return e
		}) {
			return -4
		}
	default:
		return -2
	}
	if e != nil {
		failure(e)
		return -3
	}
	return 0
}

//go:wasmexport feed
func feed(n uint32) int32 {
	if port == nil || n == 0 || n > wire.MaxDatagram {
		return -1
	}
	if e := port.Feed(port.PeerAddr().AddrPort(), buf[:n]); e != nil {
		return -2
	}
	return 0
}

//go:wasmexport drain
func drain() int32 {
	if port == nil {
		return 0
	}
	b, ok := port.Drain()
	if !ok {
		return 0
	}
	return int32(copy(buf[:], b))
}

//go:wasmexport event
func event() int32 {
	select {
	case b := <-events:
		return int32(copy(buf[:], b))
	default:
		if ctx.Err() != nil {
			return -1
		}
		return 0
	}
}

//go:wasmexport shutdown
func shutdown() {
	cancel()
	if port != nil {
		port.Close()
	}
	if peer != nil {
		go peer.Close()
	}
	if session != nil {
		go session.CloseWithError(0, "closed")
	}
	step()
}
func main() {}
