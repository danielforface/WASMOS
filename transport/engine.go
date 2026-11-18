// Package transport runs the wire protocols against a caller-owned packet port.
// Neither constructor opens a socket. In particular this is not a JS WebRTC binding.
package transport

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/transport/v5/vnet"
	"github.com/pion/webrtc/v4"
	"github.com/quic-go/quic-go"
	wt "github.com/quic-go/webtransport-go"
)

// DialWebTransport binds the TLS name to the URL, always sends the initiating
// Origin, and uses only the supplied packet port, root pool and deny policy.
// Caller owns port; peer is the *previously authorized* resolved destination.
func DialWebTransport(ctx context.Context, port net.PacketConn, peer *net.UDPAddr, target, origin string, roots *x509.CertPool, denied map[[32]byte]bool) (*wt.Session, error) {
	u, e := url.Parse(target)
	if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || roots == nil || port == nil || peer == nil {
		return nil, errors.New("invalid WebTransport destination")
	}
	o, e := url.Parse(origin)
	if e != nil || o.Scheme != "https" || o.Hostname() == "" || o.User != nil || o.RawQuery != "" || o.Fragment != "" || o.Path != "" {
		return nil, errors.New("invalid initiating origin")
	}
	expected := u.Port()
	if expected == "" {
		expected = "443"
	}
	_, p, _ := net.SplitHostPort(peer.String())
	if expected != p {
		return nil, errors.New("port mismatch")
	}
	tc := &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: u.Hostname(), NextProtos: []string{"h3"}, VerifyConnection: func(cs tls.ConnectionState) error {
		for _, chain := range cs.VerifiedChains {
			ok := true
			for _, cert := range chain {
				if denied[sha256.Sum256(cert.RawSubjectPublicKeyInfo)] {
					ok = false
					break
				}
			}
			if ok {
				return nil
			}
		}
		return errors.New("no permitted verified chain")
	}}
	q := &quic.Transport{Conn: port}
	d := wt.Transport{TLSClientConfig: tc, DialAddr: func(ctx context.Context, _ string, tc *tls.Config, qc *quic.Config) (*quic.Conn, error) {
		return q.Dial(ctx, peer, tc, qc)
	}}
	rsp, s, e := d.Dial(ctx, target, http.Header{"Origin": []string{origin}})
	if e != nil {
		if rsp != nil && rsp.Body != nil {
			rsp.Body.Close()
		}
		q.Close()
		d.Close()
		return nil, e
	}
	context.AfterFunc(s.Context(), func() { q.Close(); d.Close() })
	return s, nil
}

type Peer struct {
	*webrtc.PeerConnection
	mux ice.UDPMux
}

func (p *Peer) Close() error { err := p.PeerConnection.Close(); p.mux.Close(); return err }

// NewPeer gathers on a virtual interface and runs ICE, DTLS, SRTP and SCTP on
// the supplied UDP port. No NIC enumeration, resolver, mDNS or TURN fallback.
// The caller supplies signaling and must authorize remote endpoints separately.
func NewPeer(port net.PacketConn) (*Peer, error) {
	if port == nil {
		return nil, errors.New("missing packet port")
	}
	a, ok := port.LocalAddr().(*net.UDPAddr)
	if !ok || a.IP.To4() == nil || a.IP.IsUnspecified() || a.Port <= 0 {
		return nil, errors.New("IPv4 packet port required")
	}
	n, e := vnet.NewNet(&vnet.NetConfig{StaticIPs: []string{a.IP.String()}})
	if e != nil {
		return nil, e
	}
	if !a.IP.IsLoopback() {
		if e = n.AddAddress("eth0", &net.IPNet{IP: a.IP, Mask: net.CIDRMask(32, 32)}); e != nil {
			return nil, e
		}
	}
	mux := ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: port, Net: n})
	se := webrtc.SettingEngine{}
	se.SetNet(n)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	se.SetICEUDPMux(mux)
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	se.SetIncludeLoopbackCandidate(true)
	se.SetIPFilter(func(ip net.IP) bool { return ip.Equal(a.IP) })
	pc, e := webrtc.NewAPI(webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if e != nil {
		mux.Close()
		return nil, e
	}
	return &Peer{pc, mux}, nil
}

// Gather waits for ICE gathering before returning SDP; no hidden signaling server.
func (p *Peer) Gather(ctx context.Context, offer bool) (webrtc.SessionDescription, error) {
	var d webrtc.SessionDescription
	var e error
	if offer {
		d, e = p.CreateOffer(nil)
	} else {
		d, e = p.CreateAnswer(nil)
	}
	if e != nil {
		return d, e
	}
	done := webrtc.GatheringCompletePromise(p.PeerConnection)
	if e = p.SetLocalDescription(d); e != nil {
		return d, e
	}
	select {
	case <-done:
		sd := p.LocalDescription()
		if sd == nil || !strings.Contains(sd.SDP, "a=candidate:") {
			return d, errors.New("no local ICE candidate")
		}
		return *sd, nil
	case <-ctx.Done():
		return d, ctx.Err()
	}
}

const HandshakeTimeout = 15 * time.Second
