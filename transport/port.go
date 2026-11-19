package transport

import (
	"errors"
	"net"
	"net/netip"
	"os"
	"sync"
	"time"
)

const MaxDatagram = 2048 // protocol packets, not arbitrary IP fragmentation
const QueueDepth = 64

var ErrPeer = errors.New("destination not authorized by this packet port")
var ErrFull = errors.New("packet queue full")
var ErrSize = errors.New("invalid datagram size")

type deadline struct {
	mu      sync.Mutex
	when    time.Time
	changed chan struct{}
}

func (d *deadline) set(t time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.when = t
	close(d.changed)
	d.changed = make(chan struct{})
}
func (d *deadline) get() (time.Time, <-chan struct{}) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.when, d.changed
}

type Port struct {
	local, remote netip.AddrPort
	in, out       chan []byte
	done          chan struct{}
	once          sync.Once
	rd, wd        deadline
}

func validAddr(a netip.AddrPort) bool {
	return a.IsValid() && a.Port() != 0 && !a.Addr().IsUnspecified() && !a.Addr().IsMulticast()
}
func NewPort(local, remote netip.AddrPort) (*Port, error) {
	if !validAddr(local) || !validAddr(remote) || local.Addr().BitLen() != remote.Addr().BitLen() {
		return nil, ErrPeer
	}
	return &Port{local: local, remote: remote, in: make(chan []byte, QueueDepth), out: make(chan []byte, QueueDepth), done: make(chan struct{}), rd: deadline{changed: make(chan struct{})}, wd: deadline{changed: make(chan struct{})}}, nil
}
func (p *Port) LocalAddr() net.Addr                { return net.UDPAddrFromAddrPort(p.local) }
func (p *Port) PeerAddr() *net.UDPAddr             { return net.UDPAddrFromAddrPort(p.remote) }
func (p *Port) Close() error                       { p.once.Do(func() { close(p.done) }); return nil }
func (p *Port) SetDeadline(t time.Time) error      { p.rd.set(t); p.wd.set(t); return nil }
func (p *Port) SetReadDeadline(t time.Time) error  { p.rd.set(t); return nil }
func (p *Port) SetWriteDeadline(t time.Time) error { p.wd.set(t); return nil }

// Feed and Drain are non-blocking and preserve both ownership and packet boundaries.
func (p *Port) Feed(from netip.AddrPort, b []byte) error {
	if from != p.remote {
		return ErrPeer
	}
	if len(b) == 0 || len(b) > MaxDatagram {
		return ErrSize
	}
	select {
	case <-p.done:
		return net.ErrClosed
	default:
	}
	select {
	case p.in <- append([]byte(nil), b...):
		return nil
	default:
		return ErrFull
	}
}
func (p *Port) Drain() ([]byte, bool) {
	select {
	case <-p.done:
		return nil, false
	default:
	}
	select {
	case b := <-p.out:
		return b, true
	default:
		return nil, false
	}
}
func waitDeadline(d *deadline) (<-chan struct{}, <-chan time.Time, func()) {
	t, update := d.get()
	if t.IsZero() {
		return update, nil, func() {}
	}
	timer := time.NewTimer(time.Until(t))
	return update, timer.C, func() { timer.Stop() }
}
func (p *Port) ReadFrom(b []byte) (int, net.Addr, error) {
	for {
		select {
		case <-p.done:
			return 0, nil, net.ErrClosed
		default:
		}
		changed, expired, stop := waitDeadline(&p.rd)
		select {
		case <-p.done:
			stop()
			return 0, nil, net.ErrClosed
		case <-changed:
			stop()
			continue
		case <-expired:
			stop()
			return 0, nil, os.ErrDeadlineExceeded
		case packet := <-p.in:
			stop()
			return copy(b, packet), p.PeerAddr(), nil
		}
	}
}
func (p *Port) WriteTo(b []byte, a net.Addr) (int, error) {
	u, ok := a.(*net.UDPAddr)
	if !ok || u.AddrPort() != p.remote {
		return 0, ErrPeer
	}
	if len(b) == 0 || len(b) > MaxDatagram {
		return 0, ErrSize
	}
	packet := append([]byte(nil), b...)
	for {
		select {
		case <-p.done:
			return 0, net.ErrClosed
		default:
		}
		changed, expired, stop := waitDeadline(&p.wd)
		select {
		case <-p.done:
			stop()
			return 0, net.ErrClosed
		case <-changed:
			stop()
			continue
		case <-expired:
			stop()
			return 0, os.ErrDeadlineExceeded
		case p.out <- packet:
			stop()
			return len(b), nil
		}
	}
}
